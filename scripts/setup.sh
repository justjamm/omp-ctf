#!/usr/bin/env bash
# One-time setup for omp-ctf. Run from a normal terminal (not inside the OMP TUI):
#   ./scripts/setup.sh        (or: bun run setup)
# Installs, when missing: base tools, Bun, Oh My Pi (>= 18.20.0), Docker
# (macOS: Homebrew + Colima + docker CLI; Linux: Docker's official apt/dnf repository),
# starts the Docker daemon, installs this repo's dependencies, builds the two images,
# and links the plugin into OMP. Safe to re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN_OMP="18.20.0"
OS="$(uname -s)"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# version_ge A B: true when version A >= B (numeric dotted compare).
version_ge() {
	awk -v a="$1" -v b="$2" 'BEGIN {
		na = split(a, x, "."); nb = split(b, y, ".");
		for (i = 1; i <= (na > nb ? na : nb); i++) {
			if ((x[i] + 0) > (y[i] + 0)) exit 0;
			if ((x[i] + 0) < (y[i] + 0)) exit 1;
		}
		exit 0
	}'
}

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
	if [ "$OS" = "Linux" ]; then
		have sudo || die "sudo is required to install system packages (or run this script as root)."
		SUDO="sudo"
	fi
fi

# ---------------------------------------------------------------- Linux

linux_os_release() {
	# shellcheck disable=SC1091
	. /etc/os-release
	DISTRO_ID="${ID:-}"
	DISTRO_LIKE="${ID_LIKE:-}"
	DISTRO_CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
}

DOCKER_APT_LIST=/etc/apt/sources.list.d/docker.list

# docker_repo_has OS CODENAME: true when Docker's apt repository publishes that suite.
docker_repo_has() {
	curl -fsI -o /dev/null "https://download.docker.com/linux/$1/dists/$2/Release"
}

# Pick a suite Docker actually publishes: the distro's own codename when available, otherwise
# the newest supported base release (e.g. Kali "kali-rolling" -> Debian trixie).
docker_apt_suite() {
	local os="$1" candidate fallbacks
	if [ "$os" = "ubuntu" ]; then fallbacks="noble jammy"; else fallbacks="trixie bookworm"; fi
	for candidate in $DISTRO_CODENAME $fallbacks; do
		if docker_repo_has "$os" "$candidate"; then
			echo "$candidate"
			return 0
		fi
	done
	return 1
}

linux_base_packages() {
	if have apt-get; then
		log "Installing base packages (apt)"
		if ! $SUDO apt-get update -y; then
			# A docker.list from an earlier failed run (e.g. an unpublished codename) breaks every update.
			[ -f "$DOCKER_APT_LIST" ] || die "apt-get update failed."
			warn "apt-get update failed; removing $DOCKER_APT_LIST (it is re-created with a supported suite below) and retrying"
			$SUDO rm -f "$DOCKER_APT_LIST"
			$SUDO apt-get update -y
		fi
		$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg unzip git xdg-utils
	elif have dnf; then
		log "Installing base packages (dnf)"
		$SUDO dnf install -y ca-certificates curl unzip git xdg-utils dnf-plugins-core
	else
		die "Unsupported Linux distribution: need apt-get or dnf."
	fi
}

linux_install_docker() {
	if have docker; then
		log "Docker CLI already installed: $(docker --version)"
	else
		linux_os_release
		local repo_os=""
		case "$DISTRO_ID" in
			ubuntu | debian | fedora | rhel | centos) repo_os="$DISTRO_ID" ;;
			*)
				case " $DISTRO_LIKE " in
					*" ubuntu "*) repo_os="ubuntu" ;;
					*" debian "*) repo_os="debian" ;;
					*" fedora "*) repo_os="fedora" ;;
					*" rhel "* | *" centos "*) repo_os="rhel" ;;
				esac
				;;
		esac
		[ -n "$repo_os" ] || die "No official Docker repository for '$DISTRO_ID'. Install Docker Engine manually: https://docs.docker.com/engine/install/"
		if have apt-get; then
			local suite
			suite="$(docker_apt_suite "$repo_os")" ||
				die "Docker's $repo_os apt repository has no suite for '${DISTRO_CODENAME:-unknown}' or its fallbacks. Install Docker Engine manually: https://docs.docker.com/engine/install/"
			[ "$suite" = "$DISTRO_CODENAME" ] || log "Docker publishes no '$DISTRO_CODENAME' suite; using $repo_os $suite"
			log "Adding Docker's official apt repository ($repo_os $suite)"
			$SUDO install -m 0755 -d /etc/apt/keyrings
			$SUDO curl -fsSL "https://download.docker.com/linux/$repo_os/gpg" -o /etc/apt/keyrings/docker.asc
			$SUDO chmod a+r /etc/apt/keyrings/docker.asc
			echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$repo_os $suite stable" |
				$SUDO tee "$DOCKER_APT_LIST" >/dev/null
			$SUDO apt-get update -y
			$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
		else
			log "Adding Docker's official dnf repository ($repo_os)"
			local repo_url="https://download.docker.com/linux/$repo_os/docker-ce.repo"
			$SUDO dnf config-manager addrepo --from-repofile="$repo_url" 2>/dev/null ||
				$SUDO dnf config-manager --add-repo "$repo_url"
			$SUDO dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
		fi
	fi

	log "Starting the Docker daemon"
	if have systemctl && [ -d /run/systemd/system ]; then
		$SUDO systemctl enable --now docker
	elif have service; then
		$SUDO service docker start || true
	else
		warn "Could not start dockerd automatically (no systemd/service). Start it manually."
	fi

	if [ "$(id -u)" -ne 0 ] && ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
		log "Adding $USER to the docker group (log out and back in for OMP to pick it up)"
		$SUDO groupadd -f docker
		$SUDO usermod -aG docker "$USER"
	fi
}

# ---------------------------------------------------------------- macOS

mac_install() {
	if ! have brew; then
		log "Installing Homebrew"
		NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
	fi
	if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
	if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
	have brew || die "Homebrew is not on PATH after installation."

	log "Installing Colima and the docker CLI (Homebrew)"
	brew install colima docker docker-buildx
	mkdir -p "$HOME/.docker/cli-plugins"
	ln -sfn "$(brew --prefix)/opt/docker-buildx/bin/docker-buildx" "$HOME/.docker/cli-plugins/docker-buildx"

	if colima status >/dev/null 2>&1; then
		log "Colima already running"
	else
		log "Starting Colima (4 CPU, 8 GiB RAM, 60 GiB disk)"
		colima start --cpu 4 --memory 8 --disk 60
	fi
	docker context use colima >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------- Bun / OMP

install_bun() {
	export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
	export PATH="$BUN_INSTALL/bin:$PATH"
	if have bun; then
		log "Bun already installed: $(bun --version)"
		return
	fi
	log "Installing Bun (official installer)"
	curl -fsSL https://bun.sh/install | bash
	have bun || die "bun is not on PATH after installation (expected $BUN_INSTALL/bin)."
}

omp_version() {
	omp --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1
}

install_omp() {
	export PATH="$HOME/.local/bin:$PATH"
	local current=""
	if have omp; then current="$(omp_version || true)"; fi
	if [ -n "$current" ] && version_ge "$current" "$MIN_OMP"; then
		log "Oh My Pi already installed: $current"
		return
	fi
	if [ "$OS" = "Darwin" ]; then
		if [ -n "$current" ] && brew list omp >/dev/null 2>&1; then
			log "Upgrading Oh My Pi ($current < $MIN_OMP) via Homebrew"
			brew upgrade can1357/tap/omp
		elif [ -z "$current" ]; then
			log "Installing Oh My Pi via Homebrew"
			brew install can1357/tap/omp
		else
			log "Updating Oh My Pi ($current < $MIN_OMP) via Bun"
			bun install -g @oh-my-pi/pi-coding-agent@latest
		fi
	else
		log "Installing/updating Oh My Pi via Bun"
		bun install -g @oh-my-pi/pi-coding-agent@latest
	fi
	hash -r
	current="$(omp_version || true)"
	[ -n "$current" ] || die "omp is not on PATH after installation. Add ~/.bun/bin (and ~/.local/bin) to PATH and re-run."
	version_ge "$current" "$MIN_OMP" || die "omp $current is older than $MIN_OMP. Upgrade it with the tool you installed it with, then re-run."
	log "Oh My Pi $current"
}

# Run a command with docker access, using the docker group in this shell if just granted.
with_docker() {
	if docker info >/dev/null 2>&1; then
		"$@"
	elif [ "$OS" = "Linux" ] && have sg && getent group docker | grep -qw "$USER"; then
		sg docker -c "$(printf '%q ' "$@")"
	elif [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then
		die "Docker works only with sudo. Log out and back in (docker group), then re-run this script."
	else
		die "The Docker daemon is not reachable. Start it (macOS: 'colima start'; Linux: 'sudo systemctl start docker') and re-run."
	fi
}

# ---------------------------------------------------------------- main

case "$OS" in
	Darwin)
		mac_install
		;;
	Linux)
		linux_base_packages
		linux_install_docker
		;;
	*)
		die "Unsupported OS '$OS'. omp-ctf supports macOS and Linux hosts."
		;;
esac

install_bun
install_omp

log "Checking Docker"
with_docker docker info --format 'Docker server {{.ServerVersion}} ({{.OperatingSystem}})'

log "Installing omp-ctf dependencies"
(cd "$ROOT" && bun install --frozen-lockfile)

log "Building omp-ctf images (first run takes several minutes)"
with_docker bun "$ROOT/scripts/build-images.ts"

log "Linking the plugin into Oh My Pi"
(cd "$ROOT" && omp plugin link .)

log "Done. Start OMP and run /ctf."
if [ "$OS" = "Linux" ] && ! docker info >/dev/null 2>&1; then
	warn "Your current login session is not in the docker group yet. Log out and back in (or run 'newgrp docker') before starting omp."
fi
