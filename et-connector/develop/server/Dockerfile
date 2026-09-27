# 開発・検証用の etserver + sshd コンテナ（公式 Debian リポジトリの et を使う）
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg openssh-server procps \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -sSL https://github.com/MisterTea/debian-et/raw/master/et.gpg -o /etc/apt/keyrings/et.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/et.gpg] https://mistertea.github.io/debian-et/debian-source/ bookworm main" > /etc/apt/sources.list.d/et.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends et \
 && rm -rf /var/lib/apt/lists/*

# テスト用ユーザー（パスワード認証 + 公開鍵認証の両方を許可）
RUN useradd -m -s /bin/bash dev && echo 'dev:dev' | chpasswd \
 && mkdir -p /run/sshd /home/dev/.ssh && chmod 700 /home/dev/.ssh && chown dev:dev /home/dev/.ssh

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22 2022
ENTRYPOINT ["/entrypoint.sh"]
