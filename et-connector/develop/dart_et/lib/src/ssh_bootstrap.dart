import 'credentials.dart';
import 'exception.dart';

/// Builds the SSH command used to start `etterminal` on the server.
///
/// The application runs [command] over its own SSH connection, then passes
/// the output to [EtCredentials.parse].
class EtSshBootstrap {
  /// Creates a bootstrap command builder.
  const EtSshBootstrap({
    this.etterminalPath = 'etterminal',
    this.term = 'xterm-256color',
    this.verbose = 0,
    this.searchPaths = defaultSearchPaths,
  });

  /// Homebrew prefixes on Apple Silicon and Intel Macs.
  static const List<String> defaultSearchPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];

  /// Remote executable name or absolute path.
  ///
  /// SSH exec sessions often run without the login PATH, so on macOS
  /// `/opt/homebrew/bin/etterminal` or `/usr/local/bin/etterminal` may be needed.
  final String etterminalPath;

  /// Terminal type the remote shell should use.
  final String term;

  /// Verbosity passed to `etterminal --verbose`.
  final int verbose;

  /// Directories appended to `PATH` before running `etterminal`.
  ///
  /// macOS sshd runs commands with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so a
  /// Homebrew-installed `etterminal` is not found without this.
  final List<String> searchPaths;

  /// Returns the shell command, mirroring upstream `genCommand`.
  String command(EtCredentials credentials) {
    if (!RegExp(r'^[A-Za-z0-9._+-]+$').hasMatch(term)) {
      throw EtException('Invalid TERM value: $term.');
    }
    if (verbose < 0) {
      throw const EtException('verbose must not be negative.');
    }
    final payload = '${credentials.id}/${credentials.passkey}_$term';
    final run =
        "echo '$payload' | ${_shellQuote(etterminalPath)} --verbose=$verbose";
    if (searchPaths.isEmpty) return run;
    for (final dir in searchPaths) {
      if (!RegExp(r'^/[A-Za-z0-9_./+-]*$').hasMatch(dir)) {
        throw EtException('Invalid search path: $dir.');
      }
    }
    return 'PATH="\$PATH:${searchPaths.join(':')}"; export PATH; $run';
  }

  static String _shellQuote(String value) {
    if (RegExp(r'^[A-Za-z0-9_./:=+-]+$').hasMatch(value)) {
      return value;
    }
    return "'${value.replaceAll("'", r"'\''")}'";
  }
}
