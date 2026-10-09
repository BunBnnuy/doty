#!/usr/bin/env bash
# Called by the versioned deploy script on kb. Never run through ad-hoc SSH.
set -euo pipefail
cd /home/ubuntu/doty
node --test apps/server/browser-worker/egress-check.mjs apps/server/browser-worker/images-check.mjs
if ! command -v docker >/dev/null; then
  sudo -n apt-get update -qq
  sudo -n apt-get install -y ca-certificates curl
  sudo -n install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo -n tee /etc/apt/keyrings/docker.asc >/dev/null
  sudo -n chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$VERSION_CODENAME" "$(dpkg --print-architecture)" |
    sudo -n tee /etc/apt/sources.list.d/docker.sources >/dev/null
  sudo -n apt-get update -qq
  sudo -n apt-get install -y docker-ce docker-ce-cli containerd.io
fi
sudo -n systemctl enable --now docker
# Generate credentials only on first setup. They never enter deploy logs or the repo.
sudo -n install -d -m 0700 /etc/doty-browser
if ! sudo -n test -f /etc/doty-browser/worker.env; then
  sudo -n sh -c 'umask 077; printf "BROWSER_WORKER_TOKEN=%s\n" "$(openssl rand -hex 32)" > /etc/doty-browser/worker.env'
fi
sudo -n install -d /etc/systemd/system/doty-server.service.d
printf '[Service]\nEnvironmentFile=/etc/doty-browser/worker.env\n' |
  sudo -n tee /etc/systemd/system/doty-server.service.d/browser.conf >/dev/null
sudo -n systemctl daemon-reload

REVISION=$(git rev-parse HEAD)
IMAGE="doty-browser:${REVISION:0:12}"
sudo -n docker build -t "$IMAGE" apps/server/browser-worker
sudo -n docker network inspect doty-browser-private >/dev/null 2>&1 || sudo -n docker network create --internal doty-browser-private >/dev/null
PRIVATE_SUBNET=$(sudo -n docker network inspect doty-browser-private --format '{{(index .IPAM.Config 0).Subnet}}')
# Internal bridges still have a host gateway. Deny NEW connections to host
# services while allowing responses to the host's authenticated worker API calls.
sudo -n iptables -C INPUT -s "$PRIVATE_SUBNET" -m conntrack --ctstate NEW -m comment --comment doty-browser -j DROP 2>/dev/null ||
  sudo -n iptables -I INPUT -s "$PRIVATE_SUBNET" -m conntrack --ctstate NEW -m comment --comment doty-browser -j DROP
printf '[Unit]\nDescription=Block browser containers from host services\nBefore=docker.service\nAfter=network-pre.target\n[Service]\nType=oneshot\nExecStart=/bin/sh -c "iptables -C INPUT -s %s -m conntrack --ctstate NEW -m comment --comment doty-browser -j DROP || iptables -I INPUT -s %s -m conntrack --ctstate NEW -m comment --comment doty-browser -j DROP"\nRemainAfterExit=yes\n[Install]\nWantedBy=multi-user.target\n' "$PRIVATE_SUBNET" "$PRIVATE_SUBNET" |
  sudo -n tee /etc/systemd/system/doty-browser-firewall.service >/dev/null
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now doty-browser-firewall
sudo -n docker network inspect doty-browser-egress >/dev/null 2>&1 || sudo -n docker network create doty-browser-egress >/dev/null
sudo -n docker volume inspect doty-browser-profile >/dev/null 2>&1 || sudo -n docker volume create doty-browser-profile >/dev/null
# Block the server's own public addresses too; the private ranges are always blocked.
BLOCKED_IPS=$(hostname -I | tr ' ' ',' | sed 's/,$//')
for CONTAINER in doty-browser doty-browser-egress; do
  if sudo -n docker container inspect "$CONTAINER" >/dev/null 2>&1; then sudo -n docker rm -f "$CONTAINER" >/dev/null; fi
done
sudo -n docker run -d --name doty-browser-egress --restart unless-stopped \
  --network doty-browser-private --network-alias egress --read-only --cap-drop ALL \
  --security-opt no-new-privileges --memory 128m --cpus 0.25 --pids-limit 64 \
  --log-opt max-size=5m --log-opt max-file=2 -e "BLOCKED_IPS=$BLOCKED_IPS" "$IMAGE" node egress.mjs >/dev/null
sudo -n docker network connect doty-browser-egress doty-browser-egress
sudo -n docker run -d --name doty-browser --hostname doty-browser --restart unless-stopped \
  --network doty-browser-private --read-only --cap-drop ALL \
  --security-opt no-new-privileges --security-opt "seccomp=$PWD/apps/server/browser-worker/seccomp.json" \
  --memory 1536m --cpus 2 --pids-limit 256 --shm-size 128m \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m --tmpfs /home/browser/.cache:rw,nosuid,nodev,size=64m,uid=1001,gid=1001 \
  --tmpfs /home/browser/.config:rw,nosuid,nodev,size=16m,uid=1001,gid=1001 \
  --tmpfs /home/browser/.local:rw,nosuid,nodev,size=16m,uid=1001,gid=1001 \
  --mount type=volume,src=doty-browser-profile,dst=/home/browser/profile \
  --env-file /etc/doty-browser/worker.env --log-opt max-size=5m --log-opt max-file=2 "$IMAGE" >/dev/null
# Docker does not publish ports for this internal-only bridge. Use a small
# systemd TCP relay with a socket bound strictly to host loopback instead.
WORKER_IP=$(sudo -n docker inspect --format '{{(index .NetworkSettings.Networks "doty-browser-private").IPAddress}}' doty-browser)
printf '[Unit]\nDescription=Private browser API relay\nRequires=docker.service\nAfter=docker.service\n[Service]\nExecStart=/usr/lib/systemd/systemd-socket-proxyd %s:8890\nDynamicUser=yes\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateDevices=yes\nRestrictAddressFamilies=AF_INET AF_INET6\n' "$WORKER_IP" |
  sudo -n tee /etc/systemd/system/doty-browser-relay.service >/dev/null
printf '[Unit]\nDescription=Loopback socket for private browser API\n[Socket]\nListenStream=127.0.0.1:8890\n[Install]\nWantedBy=sockets.target\n' |
  sudo -n tee /etc/systemd/system/doty-browser-relay.socket >/dev/null
sudo -n systemctl stop doty-browser-relay.service || true
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now doty-browser-relay.socket
# Test from the host with the runtime credential; never print it.
sudo -n sh -c 'set -a; . /etc/doty-browser/worker.env; set +a; exec node apps/server/browser-worker/smoke.mjs'
PRIVATE_GATEWAY=$(sudo -n docker network inspect doty-browser-private --format '{{(index .IPAM.Config 0).Gateway}}')
sudo -n docker exec -i -e "BROWSER_HOST_GATEWAY=$PRIVATE_GATEWAY" doty-browser node --input-type=module < apps/server/browser-worker/network-smoke.mjs
# One bounded read-only AI task verifies the configured OpenCode path.
sudo -n sh -c 'set -a; . /etc/doty-browser/worker.env; set +a; exec node --import tsx apps/server/src/browser/smoke.ts'
echo 'browser workspace ready (2 CPUs / 1536 MiB limit; proxy 128 MiB)'
