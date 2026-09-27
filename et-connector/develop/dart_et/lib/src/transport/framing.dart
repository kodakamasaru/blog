import 'dart:io';
import 'dart:typed_data';

import '../constants.dart';
import '../exception.dart';
import 'byte_queue.dart';

// Two framings are used on the same TCP stream:
//  * handshake protobufs: 8-byte host-order (little-endian) int64 length
//    (upstream SocketHandler::writeProto)
//  * packets after the handshake: 4-byte big-endian length
//    (upstream BackedWriter::write)

/// Frames a handshake protobuf.
Uint8List frameProto(List<int> message) {
  final out = Uint8List(8 + message.length);
  ByteData.sublistView(out).setInt64(0, message.length, Endian.little);
  out.setRange(8, out.length, message);
  return out;
}

/// Reads one handshake protobuf body.
Future<Uint8List> readProto(
  ByteQueue queue, {
  int maxLength = etMaxHandshakeProtoLength,
}) async {
  final header = await queue.take(8);
  final length = ByteData.sublistView(header).getInt64(0, Endian.little);
  if (length < 0 || length > maxLength) {
    throw EtException('Invalid handshake message length: $length.');
  }
  if (length == 0) return Uint8List(0);
  return queue.take(length);
}

/// Frames a serialized wire packet.
Uint8List framePacket(List<int> serializedPacket) {
  final out = Uint8List(4 + serializedPacket.length);
  ByteData.sublistView(out).setUint32(0, serializedPacket.length, Endian.big);
  out.setRange(4, out.length, serializedPacket);
  return out;
}

/// Reads one serialized wire packet.
Future<Uint8List> readPacketFrame(ByteQueue queue) async {
  final header = await queue.take(4);
  final length = ByteData.sublistView(header).getUint32(0, Endian.big);
  if (length < 2 || length > etMaxMessageLength) {
    throw EtException('Invalid packet length: $length.');
  }
  return queue.take(length);
}

/// Writes a handshake protobuf to [socket].
void writeProto(Socket socket, List<int> message) =>
    socket.add(frameProto(message));
