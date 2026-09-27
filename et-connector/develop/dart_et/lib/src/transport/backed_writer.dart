import 'dart:collection';
import 'dart:typed_data';

import '../constants.dart';
import '../crypto/et_cipher.dart';
import '../exception.dart';
import '../protocol/packet.dart';

/// Encrypts outgoing packets and keeps them for replay after a reconnect.
///
/// Port of upstream `BackedWriter`: every packet is encrypted and numbered
/// whether or not a socket is attached, so nothing typed while offline is lost.
class BackedWriter {
  /// Creates a writer using [cipher] for the client → server direction.
  BackedWriter(
    this._cipher, {
    this.maxBackupBytes = etMaxBackupBytes,
    this.maxDisconnectedBytes = etDisconnectBufferBytes,
  });

  final EtCipher _cipher;

  /// Soft cap for retained bytes while connected.
  final int maxBackupBytes;

  /// Hard cap for bytes buffered since the link went down.
  final int maxDisconnectedBytes;
  var _disconnectedBytes = 0;

  final _backup = ListQueue<Uint8List>();
  var _backupBytes = 0;
  var _sequenceNumber = 0;

  /// Number of packets written so far.
  int get sequenceNumber => _sequenceNumber;

  /// Encrypts [packet], records it, and returns the serialized wire packet.
  ///
  /// Throws [EtException] when offline buffering would exceed
  /// [maxDisconnectedBytes]; nothing is recorded in that case, so the
  /// sequence stays consistent.
  Uint8List write(EtPacket packet, {required bool connected}) {
    if (connected) {
      _disconnectedBytes = 0;
    } else if (_disconnectedBytes + packet.payload.length + 2 + etMacLength >
        maxDisconnectedBytes) {
      throw const EtException('Offline buffer is full; wait for reconnect.');
    }
    final wire = serializeWirePacket(
      packet.header,
      _cipher.encrypt(packet.payload),
    );
    _backup.addLast(wire);
    _backupBytes += wire.length;
    _sequenceNumber++;
    if (!connected) _disconnectedBytes += wire.length;
    // Never drop data while disconnected: the peer has not seen it yet.
    while (connected && _backupBytes > maxBackupBytes && _backup.length > 1) {
      _backupBytes -= _backup.removeFirst().length;
    }
    return wire;
  }

  /// Returns packets the peer has not received, given how many it has.
  List<Uint8List> recover(int peerSequenceNumber) {
    final missing = _sequenceNumber - peerSequenceNumber;
    if (missing < 0) {
      throw const EtRecoveryException(
        'Invalid recovery sequence: peer is ahead of us.',
      );
    }
    if (missing > _backup.length) {
      throw const EtRecoveryException(
        'Peer is too far behind to recover the session.',
      );
    }
    return _backup.skip(_backup.length - missing).toList();
  }

  /// Restarts numbering and derives a new key (reset recovery).
  void reset(List<int> salt) {
    _backup.clear();
    _backupBytes = 0;
    _disconnectedBytes = 0;
    _sequenceNumber = 0;
    _cipher.rekey(salt);
  }
}
