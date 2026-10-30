module easyeda-viewer-desktop

go 1.20

// 1.20 is the last Go line that runs on Windows 7; the build script pins the
// go1.20.14 toolchain so the shipped exe keeps Win7 support (README).

require github.com/webview/webview_go v0.0.0-20240831120633-6173450d4dd6
