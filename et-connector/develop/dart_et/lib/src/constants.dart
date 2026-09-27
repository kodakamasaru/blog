/// Wire protocol version spoken by etserver 6.x / 7.x.
const int etProtocolVersion = 6;

/// Default TCP port of etserver.
const int etDefaultPort = 2022;

/// Length of the session id printed by `etterminal`.
const int etIdLength = 16;

/// Length of the passkey printed by `etterminal` (also the secretbox key size).
const int etPasskeyLength = 32;

/// Nonce MSB for client → server packets (upstream CLIENT_SERVER_NONCE_MSB).
const int etClientServerNonceMsb = 0;

/// Nonce MSB for server → client packets (upstream SERVER_CLIENT_NONCE_MSB).
const int etServerClientNonceMsb = 1;

/// XSalsa20-Poly1305 nonce length.
const int etNonceLength = 24;

/// Poly1305 tag length prepended to each ciphertext.
const int etMacLength = 16;

/// Size of the authentication challenge sent by etserver 7.x.
const int etAuthChallengeLength = 32;

/// Size of the salt used for reset recovery rekeying.
const int etEpochSaltLength = 32;

/// BLAKE2b digest length used for proofs and rekeying (crypto_generichash_BYTES).
const int etGenericHashLength = 32;

/// Max length of a handshake protobuf (upstream MAX_HANDSHAKE_PROTO_LENGTH).
const int etMaxHandshakeProtoLength = 4 * 1024;

/// Max length of any length-prefixed message (upstream 128 MiB cap).
const int etMaxMessageLength = 128 * 1024 * 1024;

/// Encrypted bytes kept for replay after a reconnect (upstream MAX_BACKUP_BYTES).
const int etMaxBackupBytes = 64 * 1024 * 1024;

/// Upstream client's maximum keepalive interval (MAX_CLIENT_KEEP_ALIVE_DURATION).
const Duration etDefaultKeepAlive = Duration(seconds: 5);

/// Encrypted bytes buffered while disconnected (upstream DISCONNECT_BUFFER_BYTES).
const int etDisconnectBufferBytes = 64 * 1024 * 1024;
