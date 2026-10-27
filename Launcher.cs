using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

namespace VuonBaiGiangLauncher
{
    static class Program
    {
        private static Process nodeProcess = null;

        [STAThread]
        static void Main()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            Directory.SetCurrentDirectory(baseDir);

            // Tự động tạo hoặc cập nhật biểu tượng ngoài Desktop ngay khi mở app
            EnsureDesktopShortcut(baseDir);

            string nodeExe = Path.Combine(baseDir, "runtime", "node.exe");
            string serverScript = Path.Combine(baseDir, "server.mjs");

            if (!File.Exists(nodeExe))
            {
                MessageBox.Show(
                    "Không tìm thấy runtime\\node.exe trong thư mục ứng dụng!\nVui lòng giải nén đầy đủ bộ cài đặt.",
                    "Fast Edit - Lỗi",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            // 1. Khởi động Node.js hoàn toàn ẩn (CreateNoWindow = true, không có bất kỳ cửa sổ console nào)
            bool isPortAlreadyOpen = IsPortOpen("127.0.0.1", 4177, 300);

            if (!isPortAlreadyOpen)
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = nodeExe,
                        Arguments = "\"" + serverScript + "\"",
                        WorkingDirectory = baseDir,
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        WindowStyle = ProcessWindowStyle.Hidden,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    };
                    nodeProcess = Process.Start(psi);
                    nodeProcess.BeginOutputReadLine();
                    nodeProcess.BeginErrorReadLine();
                }
                catch (Exception ex)
                {
                    MessageBox.Show(
                        "Không thể khởi chạy máy chủ ứng dụng: " + ex.Message,
                        "Lỗi",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return;
                }

                // Chờ cổng 4177 sẵn sàng
                int waitedMs = 0;
                while (waitedMs < 12000)
                {
                    Thread.Sleep(200);
                    waitedMs += 200;
                    if (IsPortOpen("127.0.0.1", 4177, 300))
                    {
                        break;
                    }
                }
            }

            Thread.Sleep(800);

            // 2. Mở cửa sổ ứng dụng độc lập (Native App Mode)
            string browserPath = FindAppBrowser();

            if (!string.IsNullOrEmpty(browserPath))
            {
                try
                {
                    ProcessStartInfo appPsi = new ProcessStartInfo
                    {
                        FileName = browserPath,
                        Arguments = "--app=\"http://127.0.0.1:4177\" --window-size=1360,860",
                        UseShellExecute = true
                    };
                    Process.Start(appPsi);
                }
                catch
                {
                    Process.Start("http://127.0.0.1:4177");
                }
            }
            else
            {
                try
                {
                    Process.Start("http://127.0.0.1:4177");
                }
                catch { }
            }

            // 3. Giữ Launcher chạy ngầm hoàn toàn vô hình (winexe không có cửa sổ)
            // để bảo vệ tiến trình Node.js không bao giờ bị Windows ngắt sớm.
            // Khi người dùng tắt cửa sổ app, sau 60s không có heartbeat, Node sẽ tự thoát.
            // Khi Node thoát, cổng 4177 đóng lại -> Launcher cũng tự động thoát sạch sẽ.
            if (nodeProcess != null)
            {
                AppDomain.CurrentDomain.ProcessExit += (s, e) => CleanUp();

                while (true)
                {
                    Thread.Sleep(4000);
                    if (nodeProcess.HasExited || !IsPortOpen("127.0.0.1", 4177, 500))
                    {
                        break;
                    }
                }
                CleanUp();
            }
        }

        private static void CleanUp()
        {
            try
            {
                if (nodeProcess != null && !nodeProcess.HasExited)
                {
                    nodeProcess.Kill();
                }
            }
            catch { }
        }

        private static bool IsPortOpen(string host, int port, int timeoutMs)
        {
            try
            {
                using (var client = new TcpClient())
                {
                    var result = client.BeginConnect(host, port, null, null);
                    bool success = result.AsyncWaitHandle.WaitOne(timeoutMs);
                    if (!success) return false;
                    client.EndConnect(result);
                    return true;
                }
            }
            catch { return false; }
        }

        private static string FindAppBrowser()
        {
            string[] paths = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
            };
            foreach (string p in paths) { if (File.Exists(p)) return p; }
            return null;
        }

        private static void EnsureDesktopShortcut(string baseDir)
        {
            try
            {
                string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string shortcutPath = Path.Combine(desktopPath, "Fast Edit.lnk");
                string exePath = Path.Combine(baseDir, "FastEdit.exe");
                string icoPath = Path.Combine(baseDir, "FastEdit.ico");

                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType != null)
                {
                    dynamic shell = Activator.CreateInstance(shellType);
                    dynamic shortcut = shell.CreateShortcut(shortcutPath);
                    shortcut.TargetPath = exePath;
                    shortcut.WorkingDirectory = baseDir;
                    if (File.Exists(icoPath))
                    {
                        shortcut.IconLocation = icoPath + ",0";
                    }
                    shortcut.Description = "Fast Edit - Cắt & Ghép Video Siêu Tốc";
                    shortcut.Save();
                }
            }
            catch { }
        }
    }
}
