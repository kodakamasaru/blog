import 'dart:convert';
import 'dart:typed_data';

import 'package:pinenacl/digests.dart';

import '../constants.dart';
import '../exception.dart';

/// Keyed BLAKE2b proofs used by the etserver 7.x connect handshake.
///
/// Byte-for-byte ports of upstream `connectionProofMessage` and
/// `resetDecisionMessage` (src/base/CryptoHandler.cpp).
abstract final class EtAuthProof {
  /// Proof the client sends in `ConnectAuth` to show it knows the passkey.
  static Uint8List connection({
    required List<int> key,
    required String clientId,
    required List<int> challenge,
    required bool resetIntent,
    int protocolVersion = etProtocolVersion,
  }) {
    _checkChallenge(challenge);
    final id = utf8.encode(clientId);
    final message = BytesBuilder(copy: false)
      ..add(utf8.encode('EternalTerminal connect auth v2'))
      ..addByte(0)
      ..add(utf8.encode('$protocolVersion'))
      ..addByte(0)
      ..add(utf8.encode('${id.length}'))
      ..addByte(0)
      ..add(id)
      ..addByte(0)
      ..add(utf8.encode('${challenge.length}'))
      ..addByte(0)
      ..add(challenge)
      ..addByte(0)
      ..add(utf8.encode(resetIntent ? '1' : '0'));
    return _hash(message.takeBytes(), key);
  }

  /// Proof the server attaches to a successful `ConnectResponse`.
  static Uint8List resetDecision({
    required List<int> key,
    required String clientId,
    required List<int> challenge,
    required int status,
    required bool resetRequired,
    required List<int> resetSalt,
    int protocolVersion = etProtocolVersion,
  }) {
    _checkChallenge(challenge);
    final message = BytesBuilder(copy: false)
      ..add(utf8.encode('EternalTerminal reset decision v3'))
      ..addByte(0)
      ..add(utf8.encode('$protocolVersion'))
      ..addByte(0)
      ..add(utf8.encode(clientId))
      ..addByte(0)
      ..add(utf8.encode('${challenge.length}'))
      ..addByte(0)
      ..add(challenge)
      ..addByte(0)
      ..add(utf8.encode('$status'))
      ..addByte(0)
      ..add(utf8.encode(resetRequired ? '1' : '0'))
      ..addByte(0)
      ..add(utf8.encode('${resetSalt.length}'))
      ..addByte(0)
      ..add(resetSalt);
    return _hash(message.takeBytes(), key);
  }

  /// Constant-time comparison for proofs.
  static bool equals(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff == 0;
  }

  static void _checkChallenge(List<int> challenge) {
    if (challenge.length != etAuthChallengeLength) {
      throw const EtException('Invalid authentication challenge length.');
    }
  }

  static Uint8List _hash(Uint8List message, List<int> key) => Hash.blake2b(
    message,
    digestSize: etGenericHashLength,
    key: Uint8List.fromList(key),
  );
}
