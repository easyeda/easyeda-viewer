//go:build !windows

package main

import (
	"fmt"
	"os/exec"
	"runtime"
	"unsafe"
)

func initialWindowSize() (int, int) { return 1280, 800 }

// non-Windows shells ship WebView2-equivalent runtimes with the OS; the
// download prompt is Windows-only (#18)
func webView2Available() bool      { return true }
func promptWebView2Download() bool { return false }
// profile pinning is a Windows WebView2 loader feature; other platforms keep
// their default webview data dir
func prepareWebView2Env() {}

func createHostWindow(width, height int) unsafe.Pointer { return nil }

func prepareWindow(win unsafe.Pointer, width, height int) {}

func init() {
	switch runtime.GOOS {
	case "darwin":
		openFileNative = func() (string, error) {
			return runCapture("osascript", "-e", `POSIX path of (choose file with prompt "打开 EasyEDA 工程文件")`)
		}
		openFolderNative = func() (string, error) {
			return runCapture("osascript", "-e", `POSIX path of (choose folder with prompt "选择 EasyEDA 工程文件夹")`)
		}
	default: // linux et al
		openFileNative = func() (string, error) {
			if _, err := exec.LookPath("zenity"); err == nil {
				return runCapture("zenity", "--file-selection", "--title=打开 EasyEDA 工程文件")
			}
			if _, err := exec.LookPath("kdialog"); err == nil {
				return runCapture("kdialog", "--getopenfilename", ".", "--title=打开 EasyEDA 工程文件")
			}
			return "", fmt.Errorf("install zenity or kdialog for file dialogs")
		}
		openFolderNative = func() (string, error) {
			if _, err := exec.LookPath("zenity"); err == nil {
				return runCapture("zenity", "--file-selection", "--directory", "--title=选择 EasyEDA 工程文件夹")
			}
			if _, err := exec.LookPath("kdialog"); err == nil {
				return runCapture("kdialog", "--getexistingdirectory", ".", "--title=选择 EasyEDA 工程文件夹")
			}
			return "", fmt.Errorf("install zenity or kdialog for folder dialogs")
		}
	}
}
