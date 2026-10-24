package main

import (
	"fmt"
	"log"
	"os/exec"
	"runtime"
	"strings"
)

// Bindings called from JS. Empty string = user cancelled (or dialog failed,
// in which case the frontend falls back to nothing — status bar shows no file).

// `.eprj3` 只是工程索引，不能单独加载：请在“打开文件夹”中选择完整工程目录，
// 或把工程打包为 .zip 后用“打开文件”加载。
const openFilter = "EasyEDA 工程 (*.epro2;*.esch2;*.epcb2;*.epan2;*.elib2;*.esym2;*.epru;*.zip)|*.epro2;*.esch2;*.epcb2;*.epan2;*.elib2;*.esym2;*.epru;*.zip|所有文件 (*.*)|*.*"

func openFileDialog() string {
	path, err := openNativeFileDialog()
	log.Printf("[dialog] file -> %q err=%v", path, err)
	return path
}

func openFolderDialog() string {
	path, err := openNativeFolderDialog()
	log.Printf("[dialog] folder -> %q err=%v", path, err)
	return path
}

// platform hooks set from _windows.go / _other.go
var (
	openFileNative   func() (string, error)
	openFolderNative func() (string, error)
)

func openNativeFileDialog() (string, error) {
	if openFileNative != nil {
		return openFileNative()
	}
	return "", fmt.Errorf("no dialog on %s", runtime.GOOS)
}

func openNativeFolderDialog() (string, error) {
	if openFolderNative != nil {
		return openFolderNative()
	}
	return "", fmt.Errorf("no dialog on %s", runtime.GOOS)
}

func runCapture(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
