/// Pure Dart client building blocks for the Eternal Terminal (ET) protocol.
///
/// Like dart_mosh, the package owns the ET transport only. Applications still
/// own SSH (to run `etterminal` and read its IDPASSKEY line), terminal
/// rendering, and process lifecycle.
library;

export 'src/constants.dart';
export 'src/credentials.dart';
export 'src/crypto/auth_proof.dart';
export 'src/crypto/et_cipher.dart';
export 'src/exception.dart';
export 'src/protocol/messages.dart';
export 'src/protocol/packet.dart';
export 'src/session.dart';
export 'src/ssh_bootstrap.dart';
export 'src/transport/byte_queue.dart' show EtLinkClosedException;
export 'src/transport/connection.dart';
export 'src/transport/link.dart'
    show EtSocketConnector, defaultEtSocketConnector;
