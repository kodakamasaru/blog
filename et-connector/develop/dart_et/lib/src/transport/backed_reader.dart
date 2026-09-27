import 'dart:typed_data';

import '../crypto/et_cipher.dart';
import '../exception.dart';
import '../protocol/packet.dart';

/// Decrypts incoming packets and counts them for recovery.
///
/// Port of upstream `BackedReader`. The count is what the client reports in
/// its `SequenceHeader`, so it must only advance for fully decoded packets.
class BackedReader {
  /// Creates a reader using [cipher] for the server → client direction.
  BackedReader(this._cipher);

  final EtCipher _cipher;
  var _sequenceNumber = 0;

  /// Number of packets received so far.
  int get sequenceNumber => _sequenceNumber;

  /// Decodes one serialized wire packet (`[encrypted][header][payload]`).
  EtPacket decode(Uint8List wire) {
    if (wire.length < 2) {
      throw const EtException('Packet is too short.');
    }
    if (wire[0] != 1) {
      throw const EtException('Received an unencrypted packet.');
    }
    final payload = _cipher.decrypt(Uint8List.sublistView(wire, 2));
    _sequenceNumber++;
    return EtPacket(wire[1], payload);
  }

  /// Restarts numbering and derives a new key (reset recovery).
  void reset(List<int> salt) {
    _sequenceNumber = 0;
    _cipher.rekey(salt);
  }
}
