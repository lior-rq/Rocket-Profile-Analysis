// RasaeroPatch: make RASAero II.exe loadable and headless.
//   dump   <asm> <Type>::<method>       IL around the GUI call sites
//   patch  <in.exe> <out.dll> [--verify]  flag, publicize, shim, rename
//   verify <asm>                        JIT every engine method
using System.Reflection;
using System.Runtime.CompilerServices;
using Mono.Cecil;
using Mono.Cecil.Cil;
using TypeAttributes = Mono.Cecil.TypeAttributes;
using MethodAttributes = Mono.Cecil.MethodAttributes;
using ParameterAttributes = Mono.Cecil.ParameterAttributes;

static class Program
{
    // Types the host uses. Everything else stays untouched (and unused).
    static readonly string[] EngineTypes = { "i", "y", "f", "t", "a6", "a4", "a5", "a0", "a1", "a2", "au", "ai", "a8", "aq", "az", "d", "bn", "ae", "a9", "ab", "LaunchSiteClass" };

    static int Main(string[] args)
    {
        if (args.Length < 2) { Console.Error.WriteLine("usage: dump|patch|verify ..."); return 2; }
        switch (args[0])
        {
            case "dump": return Dump(args[1], args[2]);
            case "dumpall": return DumpAll(args[1], args[2]);
            case "patch": return Patch(args[1], args[2], args.Contains("--verify"));
            case "verify": return Verify(args[1]) ? 0 : 1;
            default: Console.Error.WriteLine("unknown command " + args[0]); return 2;
        }
    }

    static ModuleDefinition Read(string path) =>
        ModuleDefinition.ReadModule(path, new ReaderParameters { InMemory = true });

    static IEnumerable<TypeDefinition> Engine(ModuleDefinition m) =>
        m.GetTypes().Where(t => EngineTypes.Contains(Outer(t).Name));

    // Drawing code and the top-level CDX1 I/O are never called headless.
    static bool SkipMethod(MethodDefinition x) =>
        x.Name == "WriteXMLFile" || x.Name == "ReadXMLFile" || x.Parameters.Any(p => p.ParameterType.FullName.StartsWith("System.Drawing.") || p.ParameterType.FullName.StartsWith("System.Windows.Forms."));

    static bool IsWinForms(TypeReference t)
    {
        if (t.FullName.StartsWith("System.Windows.Forms.")) return true;
        var td = t as TypeDefinition;
        return td != null && td.BaseType != null && IsWinForms(td.BaseType);
    }

    static TypeDefinition Outer(TypeDefinition t) { while (t.DeclaringType != null) t = t.DeclaringType; return t; }

    static bool Interesting(Instruction i)
    {
        var s = i.Operand?.ToString() ?? "";
        return s.Contains("MsgBox") || s.Contains("ah::b()") || s.Contains("ShowDialog") || s.Contains("Debugfile") || s.Contains("FileStream::.ctor");
    }

    static int Dump(string path, string spec)
    {
        var m = Read(path);
        var parts = spec.Split("::");
        var type = m.GetTypes().First(t => t.Name == parts[0] || t.FullName == parts[0]);
        foreach (var method in type.Methods.Where(x => x.Name == parts[1] && x.HasBody))
        {
            Console.WriteLine($"=== {method.FullName}");
            foreach (var v in method.Body.Variables)
                Console.WriteLine($"  local V_{v.Index}: {v.VariableType.FullName}");
            var ins = method.Body.Instructions;
            var show = new HashSet<int>();
            for (int k = 0; k < ins.Count; k++)
                if (Interesting(ins[k])) for (int j = Math.Max(0, k - 9); j <= Math.Min(ins.Count - 1, k + 3); j++) show.Add(j);
            int last = -2;
            foreach (var k in show.OrderBy(x => x))
            {
                if (k != last + 1) Console.WriteLine("  ...");
                Console.WriteLine("  " + ins[k]);
                last = k;
            }
        }
        return 0;
    }

    static int DumpAll(string path, string spec)
    {
        var m = Read(path);
        var parts = spec.Split("::");
        var type = m.GetTypes().First(t => t.Name == parts[0] || t.FullName == parts[0]);
        foreach (var method in type.Methods.Where(x => x.Name == parts[1] && x.HasBody && (parts.Length < 3 || x.Parameters.Count.ToString() == parts[2])))
        {
            Console.WriteLine($"=== {method.FullName}  maxstack={method.Body.MaxStackSize} locals={method.Body.Variables.Count} init={method.Body.InitLocals}");
            foreach (var v in method.Body.Variables) Console.WriteLine($"  local V_{v.Index}: {v.VariableType.FullName}");
            foreach (var h in method.Body.ExceptionHandlers) Console.WriteLine($"  handler {h.HandlerType} try {h.TryStart} .. {h.TryEnd} handler {h.HandlerStart} .. {h.HandlerEnd}");
            foreach (var i in method.Body.Instructions) Console.WriteLine("  " + i);
        }
        return 0;
    }

    // ---- patch --------------------------------------------------------------

    static int Patch(string inPath, string outPath, bool verify)
    {
        var m = Read(inPath);
        m.Attributes &= ~ModuleAttributes.Required32Bit;
        m.Kind = ModuleKind.Dll;
        m.EntryPoint = null;
        m.Assembly.Name.Name = "RASAeroEngine";
        m.Name = "RASAeroEngine.dll";

        int types = 0, members = 0;
        foreach (var t in m.GetTypes())
        {
            if (t.Name == "<Module>") continue;
            if (t.IsNested) t.IsNestedPublic = true; else t.IsPublic = true;
            types++;
            foreach (var f in t.Fields) { f.IsPublic = true; members++; }
            foreach (var x in t.Methods) { x.IsPublic = true; members++; }
        }
        Console.WriteLine($"publicized {types} types, {members} members");

        var shim = MakeShim(m);
        int msgbox = 0, debug = 0, dialogs = 0, locals = 0, newobjs = 0, titles = 0; var untouched = new List<string>();
        foreach (var t in Engine(m))
            foreach (var method in t.Methods.Where(x => x.HasBody && !SkipMethod(x)))
            {
                var body = method.Body;
                var ins = body.Instructions;
                foreach (var v in body.Variables)
                    if (IsWinForms(v.VariableType)) { v.VariableType = m.TypeSystem.Object; locals++; }
                foreach (var i in ins)
                    if (i.OpCode == OpCodes.Newobj && i.Operand is MethodReference ctor && ctor.DeclaringType.FullName.StartsWith("System.Windows.Forms."))
                    { i.Operand = shim.objectCtor; newobjs++; }
                for (int k = 0; k < ins.Count; k++)
                {
                    var i = ins[k];
                    if (i.OpCode == OpCodes.Call && i.Operand is MethodReference mr && mr.Name == "MsgBox" && mr.DeclaringType.Name == "Interaction")
                    {
                        // Same stack shape (object, int32, object) -> int32; the args stay as they are.
                        i.Operand = shim.fail3;
                        msgbox++;
                    }
                    else if (i.OpCode == OpCodes.Callvirt && i.Operand is MethodReference sd && sd.Name == "ShowDialog" && sd.DeclaringType.FullName == "System.Windows.Forms.Form")
                    {
                        // newobj Dialog; stloc; ldloc; callvirt ShowDialog; pop  ->  ldstr; call Fail; stloc; ldloc; nop; pop
                        int n = k - 1;
                        while (n >= 0 && ins[n].OpCode != OpCodes.Newobj) n--;
                        if (n < 0 || k - n > 4) throw new Exception($"{method.FullName}: no newobj before ShowDialog at {i}");
                        var dlg = ((MethodReference)ins[n].Operand).DeclaringType.Name;
                        ins[n].OpCode = OpCodes.Ldstr; ins[n].Operand = $"RASAero opened dialog '{dlg}' during the run";
                        body.GetILProcessor().InsertAfter(ins[n], Instruction.Create(OpCodes.Call, shim.fail));
                        k++;
                        i.OpCode = OpCodes.Nop; i.Operand = null;
                        dialogs++;
                    }
                }
                // My.Forms.MainForm chains: ah.b().a().<string field>. As a MsgBox title -> null;
                // as the Debugfile directory -> Shim.DebugDir(). Anything else is left alone.
                for (int k = 0; k + 3 < ins.Count; k++)
                {
                    var i = ins[k];
                    if (i.OpCode != OpCodes.Call || i.Operand is not MethodReference mf || mf.Name != "b" || mf.DeclaringType.Name != "ah") continue;
                    var a = ins[k + 1]; var fld = ins[k + 2]; var next = ins[k + 3];
                    bool getMain = (a.OpCode == OpCodes.Callvirt || a.OpCode == OpCodes.Call) && a.Operand is MethodReference am && am.Name == "a";
                    bool strField = fld.OpCode == OpCodes.Ldfld && fld.Operand is FieldReference fr && fr.FieldType.FullName == "System.String";
                    bool asTitle = next.OpCode == OpCodes.Call && next.Operand is MethodReference nm && nm.Name == "Fail3";
                    bool asPath = next.OpCode == OpCodes.Ldstr;
                    if (!getMain || !strField || !(asTitle || asPath)) { untouched.Add($"{method.FullName} at {i} / {a} / {fld}"); continue; }
                    if (asTitle) { i.OpCode = OpCodes.Ldnull; i.Operand = null; titles++; }
                    else { i.Operand = shim.debugDir; debug++; }
                    a.OpCode = OpCodes.Nop; a.Operand = null;
                    fld.OpCode = OpCodes.Nop; fld.Operand = null;
                }
            }
        Console.WriteLine($"neutralized: {msgbox} MsgBox, {titles} MsgBox titles, {dialogs} ShowDialog, {debug} Debugfile paths, {locals} WinForms locals, {newobjs} WinForms newobj");
        foreach (var u in untouched.Distinct()) Console.WriteLine("  left as is (uses MainForm): " + u);
        m.Write(outPath);
        Console.WriteLine($"wrote {outPath}");
        m.Dispose();
        return verify ? (Verify(outPath) ? 0 : 1) : 0;
    }

    static (MethodReference fail, MethodReference fail3, MethodReference debugDir, MethodReference objectCtor) MakeShim(ModuleDefinition m)
    {
        var core = m.TypeSystem.CoreLibrary;
        var shim = new TypeDefinition("", "RasaeroShim", TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed | TypeAttributes.Class, m.TypeSystem.Object);
        m.Types.Add(shim);

        var exType = new TypeReference("System", "InvalidOperationException", m, core);
        var exCtor = new MethodReference(".ctor", m.TypeSystem.Void, exType) { HasThis = true };
        exCtor.Parameters.Add(new ParameterDefinition(m.TypeSystem.String));
        var fail = new MethodDefinition("Fail", MethodAttributes.Public | MethodAttributes.Static, m.TypeSystem.Object);
        fail.Parameters.Add(new ParameterDefinition("message", ParameterAttributes.None, m.TypeSystem.String));
        var il = fail.Body.GetILProcessor();
        il.Emit(OpCodes.Ldarg_0);
        il.Emit(OpCodes.Newobj, exCtor);
        il.Emit(OpCodes.Throw);
        shim.Methods.Add(fail);

        // int Fail3(object message, int style, object title): the MsgBox stack shape.
        // VB's catch blocks park the real exception in Err before showing the
        // box; it becomes the InnerException.
        var toStr = new MethodReference("ToString", m.TypeSystem.String, m.TypeSystem.Object) { HasThis = true };
        var vb = m.AssemblyReferences.First(a => a.Name == "Microsoft.VisualBasic");
        var errObj = new TypeReference("Microsoft.VisualBasic", "ErrObject", m, vb);
        var errGet = new MethodReference("Err", errObj, new TypeReference("Microsoft.VisualBasic", "Information", m, vb)) { HasThis = false };
        var exceptionType = new TypeReference("System", "Exception", m, core);
        var getEx = new MethodReference("GetException", exceptionType, errObj) { HasThis = true };
        var exCtor2 = new MethodReference(".ctor", m.TypeSystem.Void, exType) { HasThis = true };
        exCtor2.Parameters.Add(new ParameterDefinition(m.TypeSystem.String));
        exCtor2.Parameters.Add(new ParameterDefinition(exceptionType));
        var fail3 = new MethodDefinition("Fail3", MethodAttributes.Public | MethodAttributes.Static, m.TypeSystem.Int32);
        fail3.Parameters.Add(new ParameterDefinition("message", ParameterAttributes.None, m.TypeSystem.Object));
        fail3.Parameters.Add(new ParameterDefinition("style", ParameterAttributes.None, m.TypeSystem.Int32));
        fail3.Parameters.Add(new ParameterDefinition("title", ParameterAttributes.None, m.TypeSystem.Object));
        il = fail3.Body.GetILProcessor();
        il.Emit(OpCodes.Ldarg_0);
        il.Emit(OpCodes.Callvirt, toStr);
        il.Emit(OpCodes.Call, errGet);
        il.Emit(OpCodes.Callvirt, getEx);
        il.Emit(OpCodes.Newobj, exCtor2);
        il.Emit(OpCodes.Throw);
        shim.Methods.Add(fail3);

        var pathType = new TypeReference("System.IO", "Path", m, core);
        var getTemp = new MethodReference("GetTempPath", m.TypeSystem.String, pathType) { HasThis = false };
        var dbg = new MethodDefinition("DebugDir", MethodAttributes.Public | MethodAttributes.Static, m.TypeSystem.String);
        il = dbg.Body.GetILProcessor();
        il.Emit(OpCodes.Call, getTemp);
        il.Emit(OpCodes.Ret);
        shim.Methods.Add(dbg);
        var objCtor = new MethodReference(".ctor", m.TypeSystem.Void, m.TypeSystem.Object) { HasThis = true };
        return (fail, fail3, dbg, objCtor);
    }

    // ---- verify -------------------------------------------------------------

    static bool Verify(string path)
    {
        var asm = Assembly.LoadFrom(Path.GetFullPath(path));
        Type[] types;
        try { types = asm.GetTypes(); }
        catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
        var engine = types.Where(t => EngineTypes.Contains(OuterName(t))).ToList();
        int ok = 0; var bad = new List<string>(); var allowed = new List<string>();
        const BindingFlags all = BindingFlags.DeclaredOnly | BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        foreach (var t in engine)
            foreach (var mb in t.GetMethods(all).Cast<MethodBase>().Concat(t.GetConstructors(all)))
            {
                if (mb.IsAbstract || mb.ContainsGenericParameters) continue;
                try { RuntimeHelpers.PrepareMethod(mb.MethodHandle); ok++; }
                catch (Exception e)
                {
                    var msg = (e.InnerException ?? e).Message.Split('\n')[0];
                    var line = $"{t.Name}.{mb.Name}({Sig(mb)}): {msg}";
                    bool gui = msg.Contains("System.Drawing") || msg.Contains("ConfigurationManager") || mb.Name == "WriteXMLFile" || mb.Name == "ReadXMLFile" || HasWinFormsParam(mb)
                        || (t.Name == "a6" && Sig(mb) == "List`1&");
                    if (gui) allowed.Add(line); else bad.Add(line);
                }
            }
        foreach (var n in new[] { "i", "y", "f", "a4", "d", "bn", "LaunchSiteClass" })
            try { Activator.CreateInstance(types.First(t => t.Name == n), true); } catch (Exception e) { bad.Add($"new {n}(): {(e.InnerException ?? e).Message.Split('\n')[0]}"); }
        Console.WriteLine($"verify: {engine.Count} engine types, {ok} methods JIT ok, {allowed.Count} allowed failures (drawing/WriteXMLFile), {bad.Count} unexpected");
        foreach (var b in bad) Console.WriteLine("  FAIL " + b);
        return bad.Count == 0;
    }

    static string Sig(MethodBase mb)
    {
        try { return string.Join(",", mb.GetParameters().Select(p => p.ParameterType.Name)); }
        catch (Exception e) { return "?" + e.Message.Split('\n')[0]; }
    }

    static bool HasWinFormsParam(MethodBase mb)
    {
        try { return mb.GetParameters().Any(p => (p.ParameterType.Namespace ?? "").StartsWith("System.Windows.Forms")); }
        catch (Exception e) { return (e.Message + (e.InnerException?.Message ?? "")).Contains("System.Windows.Forms"); }
    }

    static string OuterName(Type t) => (t.FullName ?? t.Name).Split('+')[0];
}
