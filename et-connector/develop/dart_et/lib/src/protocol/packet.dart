import 'dart:typed_data';

import '../exception.dart';

/// Packet header bytes (`EtPacketType` and `TerminalPacketType`).
abstract final class EtPacketType {
  static const int keepAlive = 0;
  static const int terminalBuffer = 1;
  static const int terminalInfo = 2;
  static const int portForwardDestinationRequest = 5;
  static const int portForwardDestinationResponse = 6;
  static const int portForwardData = 7;
  static const int terminalClose = 11;
  static const int terminalExitStatus = 12;
  static const int initialResponse = 252;
  static const int initialPayload = 253;
  static const int heartbeat = 254;
}

/// A decrypted ET packet: one header byte plus a payload.
class EtPacket {
  /// Creates a packet.
  EtPacket(this.header, [List<int> payload = const []])
    : payload = Uint8List.fromList(payload) {
    if (header < 0 || header > 0xff) {
      throw EtException('Packet header must fit in one byte: $header.');
    }
  }

  /// Application packet type.
  final int header;

  /// Plaintext payload (usually a serialized protobuf).
  final Uint8List payload;
}

/// Serialized packet on the wire: `[encrypted][header][payload]`.
///
/// The encrypted flag is always 1 for packets written by a BackedWriter.
Uint8List serializeWirePacket(int header, List<int> encryptedPayload) {
  final out = Uint8List(2 + encryptedPayload.length);
  out[0] = 1;
  out[1] = header;
  out.setRange(2, out.length, encryptedPayload);
  return out;
}
