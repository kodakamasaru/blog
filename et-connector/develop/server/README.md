# etserver 検証用コンテナ

公式 Debian リポジトリの `et`（7.0.0）と sshd を入れたコンテナ。

```sh
docker build -t et-dev-server .
ssh-keygen -t ed25519 -N '' -f ./et_test_key
docker run -d --name et-dev -p 127.0.0.1:2222:22 -p 127.0.0.1:2022:2022 \
  -v "$PWD/et_test_key.pub:/authorized_keys:ro" et-dev-server
```

ユーザー `dev`（公開鍵認証）。etserver は 2022/tcp。
