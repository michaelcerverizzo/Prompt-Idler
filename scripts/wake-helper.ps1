# All execution-state calls happen on the C# main thread. The reader thread only
# queues input so an abandoned stdin pipe cannot block the heartbeat watchdog.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.dll, System.Core.dll, System.Web.Extensions.dll -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

public static class PromptIdlerWakeHelper
{
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint flags);
    private const uint Continuous = 0x80000000;
    private const uint SystemRequired = 0x00000001;
    private const uint DisplayRequired = 0x00000002;

    public static void Run()
    {
        var input = new BlockingCollection<string>();
        var reader = new Thread(() => {
            try {
                string line;
                while ((line = Console.ReadLine()) != null) input.Add(line);
            } finally {
                input.CompleteAdding();
            }
        });
        reader.IsBackground = true;
        reader.Start();
        var json = new JavaScriptSerializer();
        var heartbeat = Stopwatch.StartNew();
        try {
            while (!input.IsCompleted && heartbeat.ElapsedMilliseconds < 15000) {
                string line;
                if (!input.TryTake(out line, 250)) continue;
                if (line.Length > 4096) break;
                var message = json.Deserialize<Dictionary<string, object>>(line);
                int id = Convert.ToInt32(message["id"]);
                string command = (string)message["command"];
                bool ok = true;
                if (command == "set") {
                    uint flags = Continuous;
                    if ((bool)message["awake"]) {
                        flags |= SystemRequired;
                        if ((bool)message["display"]) flags |= DisplayRequired;
                    }
                    ok = SetThreadExecutionState(flags) != 0;
                } else if (command == "stop") {
                    ok = SetThreadExecutionState(Continuous) != 0;
                } else if (command != "ping") {
                    break;
                }
                heartbeat.Restart();
                Console.WriteLine(json.Serialize(new { id = id, ok = ok }));
                Console.Out.Flush();
                if (!ok || command == "stop") break;
            }
        } finally {
            SetThreadExecutionState(Continuous);
        }
    }
}
'@
[PromptIdlerWakeHelper]::Run()
