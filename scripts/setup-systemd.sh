#!/usr/bin/env bash
# One-shot Phase 7 box setup: writes the systemd units, deploy poller, and
# sudoers rule, then enables everything. Idempotent — safe to re-run.
# Run on the mini-pc as: sudo bash scripts/setup-systemd.sh
set -euo pipefail

USER_NAME=minipc
DEPLOY_DIR=/home/${USER_NAME}/mountain-deploy
NODE_BIN=/usr/bin/node

echo "==> Cleaning any previous/broken units"
systemctl unmask mountain-project.service 2>/dev/null || true
rm -f /etc/systemd/system/mountain-project.service
rm -f /etc/systemd/system/mountain-deploy.service
rm -f /etc/systemd/system/mountain-deploy.timer

echo "==> Writing deploy poller script"
cat > /home/${USER_NAME}/deploy.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd ${DEPLOY_DIR}
git fetch -q origin deploy
LOCAL=\$(git rev-parse HEAD); REMOTE=\$(git rev-parse origin/deploy)
if [ "\$LOCAL" != "\$REMOTE" ]; then
  git reset --hard origin/deploy
  sudo systemctl restart mountain-project
  echo "deployed \$REMOTE"
fi
EOF
chmod +x /home/${USER_NAME}/deploy.sh
chown ${USER_NAME}:${USER_NAME} /home/${USER_NAME}/deploy.sh

echo "==> Writing app service"
cat > /etc/systemd/system/mountain-project.service <<EOF
[Unit]
Description=Mountain Project (Fastify, prod)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${DEPLOY_DIR}
EnvironmentFile=${DEPLOY_DIR}/.env
ExecStart=${NODE_BIN} ${DEPLOY_DIR}/server.js
Restart=always
RestartSec=3
MemoryMax=700M

[Install]
WantedBy=multi-user.target
EOF

echo "==> Writing deploy poller service"
cat > /etc/systemd/system/mountain-deploy.service <<EOF
[Unit]
Description=Poll deploy branch + redeploy

[Service]
Type=oneshot
User=${USER_NAME}
ExecStart=/home/${USER_NAME}/deploy.sh
EOF

echo "==> Writing deploy poller timer"
cat > /etc/systemd/system/mountain-deploy.timer <<EOF
[Unit]
Description=mountain-project deploy poll

[Timer]
OnBootSec=2min
OnUnitActiveSec=3min

[Install]
WantedBy=timers.target
EOF

echo "==> Writing sudoers rule (passwordless restart for the poller)"
echo "${USER_NAME} ALL=(root) NOPASSWD: /usr/bin/systemctl restart mountain-project" > /etc/sudoers.d/mountain-deploy
chmod 440 /etc/sudoers.d/mountain-deploy
visudo -cf /etc/sudoers.d/mountain-deploy

echo "==> Enabling + starting"
systemctl daemon-reload
systemctl enable --now mountain-project
systemctl enable --now mountain-deploy.timer

echo "==> Done. Status:"
systemctl is-active mountain-project || true
ss -tlnp 2>/dev/null | grep :3000 || true
