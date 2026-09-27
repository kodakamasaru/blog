// Hand-written codecs for the subset of ET.proto / ETerminal.proto a terminal
// client needs. Field numbers follow upstream proto/ET.proto and
// proto/ETerminal.proto (protocol version 6).
import 'dart:typed_data';

import '../constants.dart';
import 'protobuf.dart';

/// `ConnectStatus` values.
abstract final class EtConnectStatus {
  static const int newClient = 1;
  static const int returningClient = 2;
  static const int invalidKey = 3;
  static const int mismatchedProtocol = 4;
  static const int retryLater = 5;
}

/// First handshake message from the client.
class EtConnectRequest {
  const EtConnectRequest({
    required this.clientId,
    this.version = etProtocolVersion,
    this.resetIntent = false,
    this.supportsChallenge = true,
  });

  final String clientId;
  final int version;
  final bool resetIntent;
  final bool supportsChallenge;

  Uint8List encode() {
    final w = ProtoWriter()
      ..string(1, clientId)
      ..int32(2, version);
    if (resetIntent) w.boolean(3, true);
    if (supportsChallenge) w.boolean(4, true);
    return w.takeBytes();
  }

  static EtConnectRequest decode(List<int> bytes) {
    var clientId = '';
    var version = 0;
    var resetIntent = false;
    var supportsChallenge = false;
    final r = ProtoReader(bytes);
    while (!r.isDone) {
      final f = r.nextField();
      switch (f.number) {
        case 1 when f.wireType == wireTypeLengthDelimited:
          clientId = r.readString();
        case 2 when f.wireType == wireTypeVarint:
          version = r.readInt32();
        case 3 when f.wireType == wireTypeVarint:
          resetIntent = r.readBool();
        case 4 when f.wireType == wireTypeVarint:
          supportsChallenge = r.readBool();
        default:
          r.skip(f.wireType);
      }
    }
    return EtConnectRequest(
      clientId: clientId,
      version: version,
      resetIntent: resetIntent,
      supportsChallenge: supportsChallenge,
    );
  }
}

/// Server answer to [EtConnectRequest]; either a challenge or a final status.
class EtConnectResponse {
  const EtConnectResponse({
    this.status,
    this.error,
    this.authChallenge,
    this.resetRequired = false,
    this.resetProof,
    this.resetSalt,
  });

  final int? status;
  final String? error;
  final Uint8List? authChallenge;
  final bool resetRequired;
  final Uint8List? resetProof;
  final Uint8List? resetSalt;

  Uint8List encode() {
    final w = ProtoWriter();
    if (status != null) w.int32(1, status!);
    if (error != null) w.string(2, error!);
    if (authChallenge != null) w.bytes(3, authChallenge!);
    if (resetRequired) w.boolean(4, true);
    if (resetProof != null) w.bytes(5, resetProof!);
    if (resetSalt != null) w.bytes(6, resetSalt!);
    return w.takeBytes();
  }

  static EtConnectResponse decode(List<int> bytes) {
    int? status;
    String? error;
    Uint8List? authChallenge;
    var resetRequired = false;
    Uint8List? resetProof;
    Uint8List? resetSalt;
    final r = ProtoReader(bytes);
    while (!r.isDone) {
      final f = r.nextField();
      switch (f.number) {
        case 1 when f.wireType == wireTypeVarint:
          status = r.readInt32();
        case 2 when f.wireType == wireTypeLengthDelimited:
          error = r.readString();
        case 3 when f.wireType == wireTypeLengthDelimited:
          authChallenge = r.readBytes();
        case 4 when f.wireType == wireTypeVarint:
          resetRequired = r.readBool();
        case 5 when f.wireType == wireTypeLengthDelimited:
          resetProof = r.readBytes();
        case 6 when f.wireType == wireTypeLengthDelimited:
          resetSalt = r.readBytes();
        default:
          r.skip(f.wireType);
      }
    }
    return EtConnectResponse(
      status: status,
      error: error,
      authChallenge: authChallenge,
      resetRequired: resetRequired,
      resetProof: resetProof,
      resetSalt: resetSalt,
    );
  }
}

/// Client proof answering an authentication challenge.
class EtConnectAuth {
  const EtConnectAuth(this.proof);

  final Uint8List proof;

  Uint8List encode() => (ProtoWriter()..bytes(1, proof)).takeBytes();

  static EtConnectAuth decode(List<int> bytes) {
    var proof = Uint8List(0);
    final r = ProtoReader(bytes);
    while (!r.isDone) {
      final f = r.nextField();
      if (f.number == 1 && f.wireType == wireTypeLengthDelimited) {
        proof = r.readBytes();
      } else {
        r.skip(f.wireType);
      }
    }
    return EtConnectAuth(proof);
  }
}

/// Number of packets a side has received, exchanged on recovery.
class EtSequenceHeader {
  const EtSequenceHeader({
    required this.sequenceNumber,
    this.reset = false,
    this.resetSalt,
  });

  final int sequenceNumber;
  final bool reset;
  final Uint8List? resetSalt;

  Uint8List encode() {
    final w = ProtoWriter()..int32(1, sequenceNumber);
    if (reset) w.boolean(2, true);
    if (resetSalt != null) w.bytes(3, resetSalt!);
    return w.takeBytes();
  }

  static EtSequenceHeader decode(List<int> bytes) {
    var sequenceNumber = 0;
    var reset = false;
    Uint8List? resetSalt;
    final r = ProtoReader(bytes);
    while (!r.isDone) {
      final f = r.nextField();
      switch (f.number) {
        case 1 when f.wireType == wireTypeVarint:
          sequenceNumber = r.readInt32();
        case 2 when f.wireType == wireTypeVarint:
          reset = r.readBool();
        case 3 when f.wireType == wireTypeLengthDelimited:
          resetSalt = r.readBytes();
        default:
          r.skip(f.wireType);
      }
    }
    return EtSequenceHeader(
      sequenceNumber: sequenceNumber,
      reset: reset,
      resetSalt: resetSalt,
    );
  }
}

/// Serialized packets the peer missed while disconnected.
class EtCatchupBuffer {
  const EtCatchupBuffer(this.buffers);

  final List<Uint8List> buffers;

  Uint8List encode() {
    final w = ProtoWriter();
    for (final b in buffers) {
      w.bytes(1, b);
    }
    return w.takeBytes();
  }

  static EtCatchupBuffer decode(List<int> bytes) {
    final buffers = <Uint8List>[];
    final r = ProtoReader(bytes);
    while (!r.isDone) {
      final f = r.nextField();
      if (f.number == 1 && f.wireType == wireTypeLengthDelimited) {
        buffers.add(r.readBytes());
      } else {
        r.skip(f.wireType);
      }
    }
    return EtCatchupBuffer(buffers);
  }
}

/// First packet of a new session (header `INITIAL_PAYLOAD`).
class EtInitialPayload {
  const EtInitialPayload({this.supportsExitStatus = true});

  final bool supportsExitStatus;

  Uint8List encode() {
    final w = ProtoWriter();
    if (supportsExitStatus) w.boolean(6, true);
    return w.takeBytes();
  }
}

/// Server answer to [EtInitialPayload] (header `INITIAL_RESPONSE`).
class EtInitialResponse {
  const EtInitialResponse({this.error});

  final String? error;

  Uint8List encode() {
    final w = ProtoWriter();
    if (error != null) w.string(1, error!);
    return w.takeBytes();
  }

  static EtInitialResponse decode(List<int> bytes) {
    String? error;
    final r = ProtoReader(bytes);
    while (!r.isDone) {
      final f = r.nextField();
      if (f.number == 1 && f.wireType == wireTypeLengthDelimited) {
        error = r.readString();
      } else {
        r.skip(f.wireType);
      }
    }
    return EtInitialResponse(error: error);
  }
}

/// Terminal bytes in either direction (header `TERMINAL_BUFFER`).
class EtTerminalBuffer {
  const EtTerminalBuffer(this.buffer, {this.isStderr = false});

  final List<int> buffer;
  final bool isStderr;

  Uint8List encode() {
    final w = ProtoWriter()..bytes(1, buffer);
    if (isStderr) w.boolean(2, true);
    return w.takeBytes();
  }

  static EtTerminalBuffer decode(List<int> bytes) {
    var buffer = Uint8List(0);
    var isStderr = false;
    final r = ProtoReader(bytes);
    while (!r.isDone) {
      final f = r.nextField();
      switch (f.number) {
        case 1 when f.wireType == wireTypeLengthDelimited:
          buffer = r.readBytes();
        case 2 when f.wireType == wireTypeVarint:
          isStderr = r.readBool();
        default:
          r.skip(f.wireType);
      }
    }
    return EtTerminalBuffer(buffer, isStderr: isStderr);
  }
}

/// Window size update (header `TERMINAL_INFO`).
class EtTerminalInfo {
  const EtTerminalInfo({
    required this.rows,
    required this.columns,
    this.width = 0,
    this.height = 0,
  });

  final int rows;
  final int columns;
  final int width;
  final int height;

  Uint8List encode() =>
      (ProtoWriter()
            ..int32(2, rows)
            ..int32(3, columns)
            ..int32(4, width)
            ..int32(5, height))
          .takeBytes();
}

/// Remote shell wait status (header `TERMINAL_EXIT_STATUS`).
class EtTerminalExitStatus {
  const EtTerminalExitStatus(this.exitCode);

  final int? exitCode;

  Uint8List encode() {
    final w = ProtoWriter();
    if (exitCode != null) w.int32(1, exitCode!);
    return w.takeBytes();
  }

  static EtTerminalExitStatus decode(List<int> bytes) {
    int? exitCode;
    final r = ProtoReader(bytes);
    while (!r.isDone) {
      final f = r.nextField();
      if (f.number == 1 && f.wireType == wireTypeVarint) {
        exitCode = r.readInt32();
      } else {
        r.skip(f.wireType);
      }
    }
    return EtTerminalExitStatus(exitCode);
  }
}
