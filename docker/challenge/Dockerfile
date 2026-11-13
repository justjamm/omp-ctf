# Per-challenge analysis container. Runs as an unprivileged user with all capabilities dropped,
# so system package managers are unavailable at runtime; install tools per challenge with
# `pip install --user`, `python3 -m venv /work/.venv`, `npm install --prefix /work`, etc.
FROM ubuntu:24.04

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl wget git file xxd bsdextrautils binutils gdb strace ltrace \
      build-essential python3 python3-pip python3-venv python3-dev nodejs npm \
      unzip p7zip-full xz-utils zstd bzip2 jq netcat-openbsd socat procps coreutils less \
      openssl sqlite3 libimage-exiftool-perl binwalk \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 ctf \
 && useradd -u 10001 -g 10001 -m -d /home/ctf -s /bin/bash ctf \
 && mkdir -p /work \
 && chown 10001:10001 /work

ENV HOME=/home/ctf \
    PATH=/home/ctf/.local/bin:/work/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PYTHONDONTWRITEBYTECODE=1

USER 10001:10001
WORKDIR /work
CMD ["sleep", "infinity"]
