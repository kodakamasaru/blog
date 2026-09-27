// Minimal `et` replacement built on dart_et.
//
//   dart run example/et_cli.dart [user@]host [--port 2022] [--etterminal PATH] [-- ssh args...]
//
// SSH bootstrap uses the system `ssh` (key/agent auth). Send SIGUSR1 to the
// process to force a reconnect, e.g. `kill -USR1 <pid>`.
import 'dart:async';
import 'dart:io';

import 'package:dart_et/dart_et.dart';

Future<void> main(List<String> args) async {
  final options = _parse(args);
  if (options == null) {
    stderr.writeln(
      'usage: et_cli [user@]host [--port 2022] [--etterminal PATH] [-- ssh args...]',
    );
    exit(64);
  }

  final bootstrap = EtSshBootstrap(
    etterminalPath: options.etterminal,
    term: Platform.environment['TERM'] ?? 'xterm-256color',
  );
  final ssh = await Process.run('ssh', [
    ...options.sshArgs,
    options.target,
    bootstrap.command(EtCredentials.random()),
  ]);
  final EtCredentials credentials;
  try {
    credentials = EtCredentials.parse('${ssh.stdout}');
  } on EtException catch (error) {
    stderr
      ..writeln(error.message)
      ..write(ssh.stderr);
    exit(1);
  }

  final host = options.target.split('@').last;
  final session = await EtSession.connect(
    host: host,
    port: options.port,
    credentials: credentials,
    columns: stdout.hasTerminal ? stdout.terminalColumns : 80,
    rows: stdout.hasTerminal ? stdout.terminalLines : 24,
  );

  final interactive = stdin.hasTerminal;
  if (interactive) {
    stdin
      ..echoMode = false
      ..lineMode = false;
  }
  final subscriptions = <StreamSubscription<Object?>>[
    session.stdout.listen(stdout.add),
    session.stderr.listen(stderr.add),
    stdin.listen(session.send, onDone: () => session.close()),
    session.states.listen(_StatusLine().update),
    if (!Platform.isWindows)
      ProcessSignal.sigwinch.watch().listen((_) {
        session.resize(stdout.terminalColumns, stdout.terminalLines);
      }),
    if (!Platform.isWindows)
      ProcessSignal.sigusr1.watch().listen((_) => session.reconnect()),
  ];

  await session.done;
  for (final s in subscriptions) {
    await s.cancel();
  }
  if (interactive) {
    stdin
      ..lineMode = true
      ..echoMode = true;
  }
  // etserver 7.0.0 does not send TERMINAL_EXIT_STATUS: when the shell exits
  // it just drops the session, and the next reconnect gets INVALID_KEY.
  final reason = session.closeReason;
  if (reason != null && reason is! EtSessionEndedException) {
    stderr.writeln('\r\n[et: $reason]');
    exit(1);
  }
  exit(session.exitCode ?? 0);
}

/// Prints link state, hiding reconnects that finish within a second.
class _StatusLine {
  static const _grace = Duration(seconds: 1);
  Timer? _pending;
  var _shown = false;

  void update(EtConnectionState state) {
    _pending?.cancel();
    switch (state) {
      case EtConnectionState.reconnecting:
        _pending = Timer(_grace, () {
          _shown = true;
          stderr.write('\r\n[et: reconnecting...]\r\n');
        });
      case EtConnectionState.connected:
        if (_shown) stderr.write('\r\n[et: reconnected]\r\n');
        _shown = false;
      case EtConnectionState.closed:
        break;
    }
  }
}

class _Options {
  _Options(this.target, this.port, this.etterminal, this.sshArgs);

  final String target;
  final int port;
  final String etterminal;
  final List<String> sshArgs;
}

_Options? _parse(List<String> args) {
  String? target;
  var port = etDefaultPort;
  var etterminal = 'etterminal';
  final sshArgs = <String>[];
  for (var i = 0; i < args.length; i++) {
    final arg = args[i];
    if (arg == '--') {
      sshArgs.addAll(args.skip(i + 1));
      break;
    } else if (arg == '--port' && i + 1 < args.length) {
      port = int.tryParse(args[++i]) ?? -1;
    } else if (arg == '--etterminal' && i + 1 < args.length) {
      etterminal = args[++i];
    } else if (!arg.startsWith('-') && target == null) {
      target = arg;
    } else {
      return null;
    }
  }
  if (target == null || port <= 0 || port > 65535) return null;
  return _Options(target, port, etterminal, sshArgs);
}
