#!/bin/sh
set -e
if [ -f /authorized_keys ]; then
  cp /authorized_keys /home/dev/.ssh/authorized_keys
  chown dev:dev /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys
fi
ssh-keygen -A
/usr/sbin/sshd
exec etserver --port 2022 -v 1 --logtostdout
