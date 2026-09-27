import 'package:flutter/material.dart';

import 'connection/connect_screen.dart';

void main() => runApp(const EtApp());

class EtApp extends StatelessWidget {
  const EtApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'et',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF101216),
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFFE8B04B),
          brightness: Brightness.dark,
          surface: const Color(0xFF101216),
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: Color(0xFF16181D),
          elevation: 0,
        ),
        inputDecorationTheme: const InputDecorationTheme(
          border: OutlineInputBorder(),
          filled: true,
          fillColor: Color(0xFF16181D),
        ),
      ),
      home: const ConnectScreen(),
    );
  }
}
