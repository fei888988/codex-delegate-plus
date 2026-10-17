/** Toolhelp works with restricted Windows tokens that cannot query WMI or run taskkill. */
export function windowsProcessTreeScript(cpuPid = 0): string { return `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DelegateProcesses {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct Entry {
  public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
 }
 [DllImport("kernel32.dll")] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
 [DllImport("kernel32.dll", CharSet=CharSet.Auto)] public static extern bool Process32First(IntPtr h, ref Entry e);
 [DllImport("kernel32.dll", CharSet=CharSet.Auto)] public static extern bool Process32Next(IntPtr h, ref Entry e);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 public static void Print(uint root) {
  var h=CreateToolhelp32Snapshot(2,0);
  var rows=new System.Collections.Generic.List<Entry>();
  try { var e=new Entry(); e.size=(uint)Marshal.SizeOf(e);
   if(Process32First(h,ref e)) do { rows.Add(e); } while(Process32Next(h,ref e));
  } finally { CloseHandle(h); }
  var ids=new System.Collections.Generic.HashSet<uint>(); ids.Add(root);
  bool changed=true;
  while(root!=0 && changed) { changed=false; foreach(var e in rows) if(ids.Contains(e.parent) && ids.Add(e.pid)) changed=true; }
  foreach(var e in rows) if(root==0 || ids.Contains(e.pid)) {
    double cpu=0;
    if(root!=0) try { using(var p=System.Diagnostics.Process.GetProcessById((int)e.pid)) cpu=p.TotalProcessorTime.TotalMilliseconds; } catch {}
    Console.WriteLine(e.pid+" "+e.parent+" "+cpu.ToString(System.Globalization.CultureInfo.InvariantCulture));
  }
 }
}
'@
[DelegateProcesses]::Print(${Number.isInteger(cpuPid) && cpuPid > 0 ? cpuPid : 0})
`; }
