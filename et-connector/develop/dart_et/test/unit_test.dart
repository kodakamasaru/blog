import 'dart:convert';
import 'dart:typed_data';

import 'package:dart_et/dart_et.dart';
import 'package:dart_et/src/protocol/protobuf.dart';
import 'package:dart_et/src/transport/backed_reader.dart';
import 'package:dart_et/src/transport/backed_writer.dart';
import 'package:dart_et/src/transport/byte_queue.dart';
import 'package:dart_et/src/transport/framing.dart';
import 'package:test/test.dart';

Uint8List hex(String s) => Uint8List.fromList([
  for (var i = 0; i < s.length; i += 2)
    int.parse(s.substring(i, i + 2), radix: 16),
]);

String toHex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

// Vectors generated with libsodium (PyNaCl) — see README.
final key = utf8.encode('0123456789abcdefghijklmnopqrstuv');

void main() {
  group('EtCredentials', () {
    test('parses the IDPASSKEY line among login noise', () {
      final creds = EtCredentials.parse(
        'Last login: today\nIDPASSKEY:XXXabcdefghijklm/0123456789abcdefghijklmnopqrstuv\n',
      );
      expect(creds.id, 'XXXabcdefghijklm');
      expect(creds.passkey, '0123456789abcdefghijklmnopqrstuv');
    });

    test('rejects output without credentials', () {
      expect(
        () => EtCredentials.parse('bash: etterminal: command not found'),
        throwsA(isA<EtException>()),
      );
    });

    test('rejects a passkey followed by extra characters', () {
      expect(
        () => EtCredentials.parse(
          'IDPASSKEY:XXXabcdefghijklm/0123456789abcdefghijklmnopqrstuvw',
        ),
        throwsA(isA<EtException>()),
      );
    });

    test('random credentials have the upstream shape', () {
      final creds = EtCredentials.random();
      expect(creds.id, startsWith('XXX'));
      expect(creds.id, hasLength(16));
      expect(creds.passkey, hasLength(32));
    });
  });

  group('EtSshBootstrap', () {
    test('builds the upstream etterminal command', () {
      final creds = EtCredentials(
        id: 'XXXabcdefghijklm',
        passkey: '0123456789abcdefghijklmnopqrstuv',
      );
      expect(
        const EtSshBootstrap(
          etterminalPath: '/opt/homebrew/bin/etterminal',
          searchPaths: [],
        ).command(creds),
        "echo 'XXXabcdefghijklm/0123456789abcdefghijklmnopqrstuv_xterm-256color' | "
        '/opt/homebrew/bin/etterminal --verbose=0',
      );
    });

    test('appends Homebrew prefixes to PATH by default', () {
      final creds = EtCredentials(
        id: 'XXXabcdefghijklm',
        passkey: '0123456789abcdefghijklmnopqrstuv',
      );
      expect(
        const EtSshBootstrap().command(creds),
        startsWith(
          r'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; export PATH; echo ',
        ),
      );
    });

    test('rejects a search path with shell metacharacters', () {
      expect(
        () => const EtSshBootstrap(
          searchPaths: [r'/x"; echo pwned; "'],
        ).command(EtCredentials.random()),
        throwsA(isA<EtException>()),
      );
    });

    test('rejects a TERM that could break out of quotes', () {
      expect(
        () => const EtSshBootstrap(
          term: "x'; echo pwned",
        ).command(EtCredentials.random()),
        throwsA(isA<EtException>()),
      );
    });
  });

  group('EtCipher', () {
    test('matches libsodium crypto_secretbox for client→server packets', () {
      final cipher = EtCipher(key, etClientServerNonceMsb);
      expect(
        toHex(cipher.encrypt(utf8.encode('hello'))),
        '3b07b7b0d45d42ca10fcbf15b43932a037c9f79b20',
      );
      expect(
        toHex(cipher.encrypt(const [])),
        '4e628022e05e87b7e6161d4da8d68d37',
      );
    });

    test('decrypts libsodium server→client packets', () {
      final cipher = EtCipher(key, etServerClientNonceMsb);
      expect(
        utf8.decode(
          cipher.decrypt(hex('1685aaa3b4ab07d1d76966a88e888874973ba69eee')),
        ),
        'world',
      );
    });

    test('rekey derives the BLAKE2b epoch key and restarts the nonce', () {
      final cipher = EtCipher(key, etClientServerNonceMsb)..encrypt(const [1]);
      cipher.rekey(List.generate(32, (i) => i));
      expect(
        toHex(cipher.encrypt(utf8.encode('after'))),
        '3223eaefa5a4e0fa57e96b094f6949173364409d12',
      );
    });

    test('fails loudly on a tampered payload', () {
      final box = EtCipher(key, 0).encrypt(utf8.encode('hello'));
      box[box.length - 1] ^= 1;
      expect(() => EtCipher(key, 0).decrypt(box), throwsA(isA<EtException>()));
    });
  });

  group('EtAuthProof', () {
    final challenge = List.filled(32, 7);
    test('connection proof matches upstream message layout', () {
      final proof = EtAuthProof.connection(
        key: key,
        clientId: 'XXXabcdefghijklm',
        challenge: challenge,
        resetIntent: false,
      );
      expect(
        toHex(proof),
        '5f11cf1614e8e566ba4e0e225961f0f97750166c9729acae6bf83106128ae4b1',
      );
    });

    test('reset decision proof matches upstream message layout', () {
      final proof = EtAuthProof.resetDecision(
        key: key,
        clientId: 'XXXabcdefghijklm',
        challenge: challenge,
        status: EtConnectStatus.newClient,
        resetRequired: false,
        resetSalt: const [],
      );
      expect(
        toHex(proof),
        '0f3a1bd42230320ee081d10679af643c142b48875b9ca0a040b45f64b59488b9',
      );
    });
  });

  group('protobuf', () {
    test('ConnectRequest encodes like protoc', () {
      final bytes = const EtConnectRequest(clientId: 'AB').encode();
      // 0a 02 'A' 'B' | 10 06 | 20 01
      expect(
        toHex(bytes),
        '0a0241421006'
        '2001',
      );
      final decoded = EtConnectRequest.decode(bytes);
      expect(decoded.clientId, 'AB');
      expect(decoded.version, 6);
      expect(decoded.supportsChallenge, isTrue);
    });

    test('negative int32 round-trips as a 10-byte varint', () {
      final bytes = (ProtoWriter()..int32(1, -1)).takeBytes();
      expect(bytes, hasLength(11));
      final r = ProtoReader(bytes)..nextField();
      expect(r.readInt32(), -1);
    });

    test('decoders skip unknown fields', () {
      final bytes =
          (ProtoWriter()
                ..string(99, 'future')
                ..int32(1, EtConnectStatus.returningClient))
              .takeBytes();
      expect(
        EtConnectResponse.decode(bytes).status,
        EtConnectStatus.returningClient,
      );
    });

    test('CatchupBuffer keeps entry order', () {
      final buf = EtCatchupBuffer([
        Uint8List.fromList([1]),
        Uint8List.fromList([2, 3]),
      ]);
      expect(EtCatchupBuffer.decode(buf.encode()).buffers, [
        [1],
        [2, 3],
      ]);
    });
  });

  group('framing', () {
    test('handshake protos use a little-endian int64 length', () async {
      final framed = frameProto([9, 9, 9]);
      expect(framed.sublist(0, 8), [3, 0, 0, 0, 0, 0, 0, 0]);
      final q = ByteQueue()..add(framed);
      expect(await readProto(q), [9, 9, 9]);
    });

    test('packets use a big-endian uint32 length', () async {
      final framed = framePacket([1, 2, 3]);
      expect(framed.sublist(0, 4), [0, 0, 0, 3]);
      final q = ByteQueue()..add(framed);
      expect(await readPacketFrame(q), [1, 2, 3]);
    });

    test('rejects an oversized handshake length before allocating', () async {
      final q = ByteQueue()
        ..add(frameProto(List.filled(etMaxHandshakeProtoLength + 1, 0)));
      expect(readProto(q), throwsA(isA<EtException>()));
    });
  });

  group('ByteQueue', () {
    test('reassembles reads across chunk boundaries', () async {
      final q = ByteQueue();
      final pending = q.take(5);
      q
        ..add(Uint8List.fromList([1, 2]))
        ..add(Uint8List.fromList([3, 4, 5, 6]));
      expect(await pending, [1, 2, 3, 4, 5]);
      expect(await q.take(1), [6]);
    });

    test('close fails the pending read with a link error', () {
      final q = ByteQueue();
      final pending = q.take(1);
      q.close();
      expect(pending, throwsA(isA<EtLinkClosedException>()));
    });
  });

  group('BackedWriter / BackedReader', () {
    test('writer output decodes in order on the reader side', () {
      final writer = BackedWriter(EtCipher(key, 0));
      final reader = BackedReader(EtCipher(key, 0));
      final a = writer.write(EtPacket(1, [1]), connected: true);
      final b = writer.write(EtPacket(2, [2]), connected: true);
      expect(reader.decode(a).header, 1);
      expect(reader.decode(b).payload, [2]);
      expect(reader.sequenceNumber, 2);
    });

    test('recover returns exactly the packets the peer is missing', () {
      final writer = BackedWriter(EtCipher(key, 0));
      final wires = [
        for (var i = 0; i < 4; i++)
          writer.write(EtPacket(1, [i]), connected: false),
      ];
      expect(writer.recover(4), isEmpty);
      expect(writer.recover(1), wires.sublist(1));
    });

    test(
      'caps bytes buffered while offline without consuming a sequence number',
      () {
        final writer = BackedWriter(EtCipher(key, 0), maxDisconnectedBytes: 64);
        writer.write(EtPacket(1, List.filled(20, 0)), connected: false);
        expect(
          () => writer.write(EtPacket(1, List.filled(40, 0)), connected: false),
          throwsA(isA<EtException>()),
        );
        expect(writer.sequenceNumber, 1);
        // Reconnecting resets the offline budget.
        writer.write(EtPacket(1, List.filled(40, 0)), connected: true);
        writer.write(EtPacket(1, List.filled(40, 0)), connected: false);
        expect(writer.sequenceNumber, 3);
      },
    );

    test('recover refuses a peer that claims to be ahead', () {
      final writer = BackedWriter(EtCipher(key, 0))
        ..write(EtPacket(1), connected: true);
      expect(() => writer.recover(5), throwsA(isA<EtRecoveryException>()));
    });

    test('recover refuses a peer behind the trimmed backup', () {
      final writer = BackedWriter(EtCipher(key, 0), maxBackupBytes: 40);
      for (var i = 0; i < 10; i++) {
        writer.write(EtPacket(1, List.filled(10, i)), connected: true);
      }
      expect(() => writer.recover(0), throwsA(isA<EtRecoveryException>()));
    });
  });
}
