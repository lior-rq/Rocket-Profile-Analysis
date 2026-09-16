// rasaero-host: RASAero II's flight-sim and aero code, headless, over JSON lines.
// Obfuscated names (i, y, f, t, a4, a5, a6, bn, ae, d) are RASAero's own; see native/README.md.
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using RASAeroII;

static class Program
{
    static readonly Dictionary<string, Design> Designs = new();
    static readonly Motors MotorDb = new();

    static int Main(string[] args)
    {
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            object reply;
            string id = null;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var req = doc.RootElement;
                id = req.TryGetProperty("id", out var idEl) ? idEl.ToString() : null;
                reply = Handle(req);
            }
            catch (Exception e)
            {
                reply = new { ok = false, error = e.GetType().Name + ": " + e.Message };
            }
            var json = JsonSerializer.Serialize(reply);
            if (id != null) json = "{\"id\":" + JsonSerializer.Serialize(id) + "," + json.Substring(1);
            stdout.WriteLine(json);
        }
        return 0;
    }

    static object Handle(JsonElement req)
    {
        switch (req.GetProperty("op").GetString())
        {
            case "ping":
                return new { ok = true, version = typeof(global::y).Assembly.GetName().Version.ToString(), engine = EngineHash(), motors = MotorDb.Count };
            case "motors":
            {
                var files = req.GetProperty("files").EnumerateArray().Select(x => x.GetString()).ToList();
                var added = MotorDb.Load(files);
                return new { ok = true, added, names = MotorDb.Names };
            }
            case "design":
            {
                var path = req.GetProperty("cdx1").GetString();
                var idv = req.TryGetProperty("design", out var d) ? d.GetString() : Path.GetFileNameWithoutExtension(path);
                var design = Design.Load(path);
                Designs[idv] = design;
                return new { ok = true, design = idv, stages = design.Stages().Count, parts = design.Parts.Count, site = design.SiteInfo(), sims = design.Sims };
            }
            case "fly":
            {
                var design = DesignFor(req).WithOverrides(req);
                double dt = req.TryGetProperty("dt", out var dtEl) ? dtEl.GetDouble() : 0.01;
                double timeBase = req.TryGetProperty("time_base_s", out var tb) ? tb.GetDouble() : dt;
                string historyDir = req.TryGetProperty("history_dir", out var hd) && hd.ValueKind == JsonValueKind.String ? hd.GetString() : null;
                // rows MAY be arrays in `fields` order; `compact` answers with arrays
                // (RESULT order below); `inline_history` adds the sampled history rows.
                string[] fields = req.TryGetProperty("fields", out var fe) && fe.ValueKind == JsonValueKind.Array ? fe.EnumerateArray().Select(x => x.GetString()).ToArray() : null;
                bool compact = req.TryGetProperty("compact", out var ce) && ce.ValueKind == JsonValueKind.True;
                bool inlineHist = req.TryGetProperty("inline_history", out var ie) && ie.ValueKind == JsonValueKind.True;
                int every = Math.Max(1, (int)Math.Round(timeBase / dt));
                var rows = req.TryGetProperty("rows", out var rowsEl) ? rowsEl.EnumerateArray().Select(x => FlightRow.From(x, fields)).ToList() : design.Sims.Select(FlightRow.From).ToList();
                var results = new List<object>();
                for (int k = 0; k < rows.Count; k++)
                {
                    var row = rows[k];
                    string hist = historyDir != null ? Path.Combine(historyDir, (row.Name ?? $"row{k:D2}") + ".csv") : null;
                    FlightResult r = null;
                    string err = null;
                    try
                    {
                        r = Flight.Fly(design, row, MotorDb, (float)dt);
                        if (hist != null) { Directory.CreateDirectory(historyDir); Csv.WriteHistory(hist, r.History, every); }
                    }
                    catch (Exception e)
                    {
                        err = Describe(e);
                        hist = null;
                    }
                    var hrows = (inlineHist && r != null) ? Csv.HistoryBlock(r.History, every) : null;
                    if (compact)
                        results.Add(new object[] { r?.MaxAlt, r?.MaxVel, r?.TimeToApogee, r?.TimeMaxVel, r?.FlightTime, r?.History.Count ?? 0, hist, err, hrows });
                    else
                        results.Add(new { max_alt_ft = r?.MaxAlt, max_vel_fps = r?.MaxVel, t_apogee_s = r?.TimeToApogee, t_max_vel_s = r?.TimeMaxVel, t_flight_s = r?.FlightTime, steps = r?.History.Count ?? 0, history = hist, error = err, history_rows = hrows });
                }
                return new { ok = true, rows = results, history_cols = inlineHist ? Csv.HeaderCols : null, history_format = inlineHist ? "f64le-b64" : null };
            }
            case "aero":
            {
                var design = DesignFor(req).WithOverrides(req);
                var config = req.GetProperty("config").GetString();
                double alt = req.GetProperty("altitude_ft").GetDouble();
                double? noz = req.TryGetProperty("nozzle_in", out var nz) && nz.ValueKind == JsonValueKind.Number ? nz.GetDouble() : null;
                decimal machMax = req.TryGetProperty("mach_max", out var mm) ? mm.GetDecimal() : 25m;
                decimal step = req.TryGetProperty("mach_step", out var ms) ? ms.GetDecimal() : 0.01m;
                var csv = req.GetProperty("csv").GetString();
                int n = Aero.Table(design, config, alt, noz, machMax, step, csv);
                return new { ok = true, rows = n, csv };
            }
            default:
                return new { ok = false, error = "unknown op" };
        }
    }

    static string Describe(Exception e)
    {
        var parts = new List<string>();
        for (var x = e; x != null; x = x.InnerException) parts.Add(x.Message.Replace("\r\n", " ").Replace("\n", " ").Trim());
        var inner = e.InnerException;
        while (inner?.InnerException != null) inner = inner.InnerException;
        var where = inner?.StackTrace?.Split('\n').FirstOrDefault()?.Trim();
        return string.Join(" <- ", parts) + (where != null ? " [" + where + "]" : "");
    }

    static Design DesignFor(JsonElement req)
    {
        if (req.TryGetProperty("design", out var d) && d.ValueKind == JsonValueKind.String && Designs.TryGetValue(d.GetString(), out var known)) return known;
        if (req.TryGetProperty("cdx1", out var p)) return Design.Load(p.GetString());
        throw new ArgumentException("need 'design' (loaded) or 'cdx1' (path)");
    }

    static string EngineHash()
    {
        var path = typeof(global::y).Assembly.Location;
        using var s = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(s))[..16].ToLowerInvariant();
    }
}

// ---- CDX1 -> RASAero part objects, site, recovery, Mach-Alt, design flags -----

sealed class Design
{
    public List<global::a5> Parts = new();
    public global::d Recover = new();
    public LaunchSiteClass Site = new();
    public List<global::bn> MachAlt = new();
    public bool Barrowman, Turbulence;
    public float SurfaceFinish;
    public string Surface = "";
    public List<Dictionary<string, object>> Sims = new();

    // RASAero's combo box roughness values (main form, surface finish handler).
    static readonly Dictionary<string, float> Roughness = new()
    {
        ["Smooth (Zero Roughness)"] = 0f, ["Polished"] = 5E-05f, ["Sheet Metal"] = 0.00016f, ["Smooth Paint"] = 0.00025f,
        ["Camouflage Paint"] = 0.0004f, ["Rough Camouflage Paint"] = 0.0012f, ["Galvanized Metal"] = 0.006f, ["Cast Iron (Very Rough)"] = 0.01f,
    };

    public static Design Load(string path)
    {
        var doc = new XmlDocument();
        doc.Load(path);
        var dsg = new Design();
        foreach (XmlNode node in doc.DocumentElement.ChildNodes)
        {
            switch (node.Name)
            {
                case "RocketDesign":
                    foreach (XmlNode c in node.ChildNodes)
                    {
                        if (c.NodeType != XmlNodeType.Element) continue;
                        switch (c.Name)
                        {
                            case "NoseCone": { var p = new global::a0(); global::t.ExtractNC(c, p); dsg.Parts.Add(p); break; }
                            case "BodyTube": { var p = new global::au(); global::t.ExtractBT(c, p); dsg.Parts.Add(p); break; }
                            case "FinCan": { var p = new global::a1(); global::t.ExtractFC(c, p); dsg.Parts.Add(p); break; }
                            case "Booster": { var p = new global::a2(); global::t.ExtractBoost(c, p); dsg.Parts.Add(p); break; }
                            case "BoatTail": { var p = new global::ai(); global::t.ExtractBoat(c, p); dsg.Parts.Add(p); break; }
                            case "Transition": { var p = new global::a8(); global::t.ExtractTrans(c, p); dsg.Parts.Add(p); break; }
                            case "Surface": dsg.Surface = (c.InnerText ?? "").Trim(); dsg.SurfaceFinish = Roughness.GetValueOrDefault(dsg.Surface, 0f); break;
                            case "ModifiedBarrowman": dsg.Barrowman = Bool(c.InnerText); break;
                            case "Turbulence": dsg.Turbulence = Bool(c.InnerText); break;
                        }
                    }
                    break;
                case "LaunchSite": global::t.GetLaunchSite(node, ref dsg.Site); break;
                case "Recovery": global::t.GetRecovery(node, ref dsg.Recover); break;
                case "MachAlt": global::t.GetMachAlt(node, ref dsg.MachAlt); break;
                case "SimulationList":
                    foreach (XmlNode s in node.ChildNodes)
                        if (s.Name == "Simulation") dsg.Sims.Add(SimRow(s));
                    break;
            }
        }
        if (dsg.Parts.Count == 0) throw new InvalidDataException(path + ": no parts in <RocketDesign>");
        PostLoad(dsg.Parts);
        return dsg;
    }

    // The main form's pass over a freshly read part list (ar.j / ar.i / ar.b):
    // diameters flow down the stack, boattail fields are reset and re-derived,
    // fin overhang and the fin root diameters (fin fields l, m) are computed.
    // The aero model reads those fields, so a file alone is not enough.
    static void PostLoad(List<global::a5> parts)
    {
        float dia = 0f;
        global::a5 prev = null;
        foreach (var item in parts)
        {
            switch (item.s())
            {
                case "NoseCone": dia = item.h(); break;
                case "BodyTube": Refl.Call(item, "a", dia); Refl.Set(item, "i", 0f); Refl.Set(item, "j", 0f); break;
                case "FinCan":
                {
                    float thick = (float)Refl.Call(item, "d");
                    Refl.Set(item, "a", dia);
                    Refl.Call(item, "a", (float)Refl.Get(item, "a") + thick * 2f);
                    dia = item.h();
                    break;
                }
                case "Transition": Refl.Set(item, "a", dia); dia = (float)Refl.Get(item, "b"); break;
                case "BoatTail":
                    Refl.Set(item, "a", dia);
                    if (prev != null && prev.s() == "BodyTube") { Refl.Set(prev, "i", item.p()); Refl.Set(prev, "j", (float)Refl.Get(item, "b")); }
                    break;   // RASAero compares against "Fincan" (never matches "FinCan"); kept as is
                case "Booster":
                    Refl.Set(item, "a", dia);
                    if ((float)Refl.Get(item, "b") > 0f) dia = item.h(); else Refl.Call(item, "a", dia);
                    break;
            }
            prev = item;
        }
        for (int k = 0; k < parts.Count; k++)
        {
            var item = parts[k];
            switch (item.s())
            {
                case "BodyTube":
                {
                    if (!(bool)Refl.Call(item, "k")) break;
                    var fin = (global::au.a)Refl.Get(item, "f");
                    fin.l = item.h(); fin.m = item.h();
                    Refl.Call(item, "k", (float)Math.Max(fin.a - fin.e, 0.0));
                    if (item.q() > 0f)
                    {
                        float behind = 0f;
                        for (int n = k + 1; n < parts.Count; n++)
                        {
                            var next = parts[n];
                            bool stop = false;
                            switch (next.s())
                            {
                                case "BodyTube":
                                    behind += next.p();
                                    if (behind > item.q()) { stop = true; Refl.Set(item, "k", 0f); }
                                    break;
                                case "BoatTail":
                                {
                                    Refl.Set(item, "k", behind); Refl.Set(item, "i", next.p()); Refl.Set(item, "j", (float)Refl.Get(next, "b"));
                                    float slope = ((float)Refl.Get(next, "a") - (float)Refl.Get(next, "b")) / next.p();
                                    fin.m = (float)Refl.Get(next, "a") - slope * item.q();
                                    stop = true;
                                    break;
                                }
                                case "Transition": stop = true; break;
                            }
                            if (stop) break;
                        }
                    }
                    Refl.Set(item, "f", fin);
                    break;
                }
                case "BoatTail":
                {
                    var fin = (global::ai.a)Refl.Get(item, "e");
                    float a = (float)Refl.Get(item, "a"), b = (float)Refl.Get(item, "b");
                    float slope = (a - b) / item.p();
                    float back = item.p() - fin.e;
                    float front = fin.a + back;
                    fin.l = a - slope * back; fin.m = a - slope * front;
                    Refl.Set(item, "e", fin);
                    break;
                }
                case "FinCan":
                {
                    var fin = (global::au.a)Refl.Get(item, "f");
                    fin.l = item.h(); fin.m = item.h();
                    Refl.Set(item, "f", fin);
                    break;
                }
                case "Booster":
                {
                    var fin = (global::au.a)Refl.Get(item, "f");
                    Refl.Call(item, "k", (float)Math.Max(fin.a - fin.e, 0.0));
                    fin.l = item.h(); fin.m = item.h();
                    Refl.Set(item, "f", fin);
                    break;
                }
            }
        }
    }

    static bool Bool(string s) => string.Equals((s ?? "").Trim(), "True", StringComparison.OrdinalIgnoreCase);

    static Dictionary<string, object> SimRow(XmlNode s)
    {
        var d = new Dictionary<string, string>();
        foreach (XmlNode c in s.ChildNodes) if (c.NodeType == XmlNodeType.Element) d[c.Name] = (c.InnerText ?? "").Trim();
        double F(string k) => d.TryGetValue(k, out var v) && double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var x) ? x : 0.0;
        return new Dictionary<string, object>
        {
            ["sustainer_engine"] = d.GetValueOrDefault("SustainerEngine", ""), ["booster_engine"] = d.GetValueOrDefault("Booster1Engine", ""),
            ["sustainer_wt_lb"] = F("SustainerLaunchWt"), ["sustainer_cg_in"] = F("SustainerCG"), ["sustainer_nozzle_in"] = F("SustainerNozzleDiameter"),
            ["combined_wt_lb"] = F("Booster1LaunchWt"), ["combined_cg_in"] = F("Booster1CG"), ["booster_nozzle_in"] = F("Booster1NozzleDiameter"),
            ["sep_delay_s"] = F("Booster1SeparationDelay"), ["ign_delay_s"] = F("SustainerIgnitionDelay"), ["booster_ign_delay_s"] = F("Booster1IgnitionDelay"),
            ["include_booster"] = Bool(d.GetValueOrDefault("IncludeBooster1", "True")),
            ["max_alt_ft"] = F("MaxAltitude"), ["max_vel_fps"] = F("MaxVelocity"), ["t_apogee_s"] = F("TimetoApogee"),
        };
    }

    // A copy with the request's launch_site / surface_finish applied, the way
    // the pipeline edits the CDX1 before a VM run.
    public Design WithOverrides(JsonElement req)
    {
        bool hasSite = req.TryGetProperty("site", out var site) && site.ValueKind == JsonValueKind.Object;
        bool hasSurface = req.TryGetProperty("surface_finish", out var surf) && surf.ValueKind == JsonValueKind.String;
        bool hasBarrow = req.TryGetProperty("barrowman", out var bar) && (bar.ValueKind == JsonValueKind.True || bar.ValueKind == JsonValueKind.False);
        bool hasTurb = req.TryGetProperty("turbulence", out var tur) && (tur.ValueKind == JsonValueKind.True || tur.ValueKind == JsonValueKind.False);
        if (!hasSite && !hasSurface && !hasBarrow && !hasTurb) return this;
        var d = (Design)MemberwiseClone();
        d.Site = Site.Copy();
        if (hasSite)
        {
            float? G(string k) => site.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? (float)v.GetDouble() : null;
            d.Site.Altitude = G("altitude_ft") ?? d.Site.Altitude; d.Site.Pressure = G("pressure_inhg") ?? d.Site.Pressure;
            d.Site.RodAngle = G("rod_angle_deg") ?? d.Site.RodAngle; d.Site.RodLength = G("rod_length_ft") ?? d.Site.RodLength;
            d.Site.Temperature = G("temperature_f") ?? d.Site.Temperature; d.Site.WindSpeed = G("wind_speed_mph") ?? d.Site.WindSpeed;
        }
        if (hasSurface) { d.Surface = surf.GetString(); d.SurfaceFinish = Roughness.GetValueOrDefault(d.Surface, 0f); }
        if (hasBarrow) d.Barrowman = bar.GetBoolean();
        if (hasTurb) d.Turbulence = tur.GetBoolean();
        return d;
    }

    public object SiteInfo() => new { altitude_ft = Site.Altitude, pressure_inhg = Site.Pressure, rod_angle_deg = Site.RodAngle, rod_length_ft = Site.RodLength, temperature_f = Site.Temperature, wind_speed_mph = Site.WindSpeed, surface = Surface, barrowman = Barrowman, turbulence = Turbulence };

    // The GUI's stage list: parts before the first Booster part = the
    // sustainer ("S"); every Booster part starts a new stage that holds
    // everything above it as well ("B"). Fresh objects on every call.
    public List<global::a4> Stages()
    {
        var acc = new global::a4 { turbulence = Turbulence, barrowman = Barrowman, recover = Recover, SurfaceFinish = SurfaceFinish, site = Site };
        var stages = new List<global::a4>();
        foreach (var part in Parts)
        {
            if (part.s() == "Booster") { stages.Add(acc.a()); acc.Stage = "B"; }
            acc.StageParts.Add(part);
        }
        stages.Add(acc.a());
        return stages;
    }
}

// ---- motors: RASAero's own .eng parser -----------------------------------------

sealed class Motors
{
    readonly Dictionary<string, global::f> byName = new();
    public int Count => byName.Count;
    public List<string> Names => byName.Keys.OrderBy(x => x).ToList();

    public int Load(IEnumerable<string> files)
    {
        int added = 0;
        foreach (var file in files)
        {
            var list = new List<global::f>();
            object target = list;
            using var reader = new StreamReader(file);
            new global::f().a(ref target, reader);
            foreach (var m in list) { byName[m.h()] = m; added++; }
        }
        return added;
    }

    public global::f Find(string name)
    {
        if (byName.TryGetValue(name, out var m)) return m;
        var hit = byName.Values.FirstOrDefault(x => x.q() == name);
        if (hit != null) return hit;
        throw new KeyNotFoundException($"motor '{name}' is not in the loaded motor files ({byName.Count} motors)");
    }
}

// ---- one flight = the GUI's per-stage loop --------------------------------------

sealed class FlightRow
{
    public string Name, SustainerEngine, BoosterEngine;
    public double SustainerWt, SustainerCg, SustainerNozzle, CombinedWt, CombinedCg, BoosterNozzle, SepDelay, IgnDelay, BoosterIgnDelay;
    public bool IncludeBooster = true;

    public static FlightRow From(JsonElement e)
    {
        double D(string k, double dflt = 0) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : dflt;
        string S(string k) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        return new FlightRow
        {
            Name = S("name") ?? S("tag"), SustainerEngine = S("sustainer_engine") ?? "", BoosterEngine = S("booster_engine") ?? "",
            SustainerWt = D("sustainer_wt_lb"), SustainerCg = D("sustainer_cg_in"), SustainerNozzle = D("sustainer_nozzle_in"),
            CombinedWt = D("combined_wt_lb"), CombinedCg = D("combined_cg_in"), BoosterNozzle = D("booster_nozzle_in"),
            SepDelay = D("sep_delay_s"), IgnDelay = D("ign_delay_s"), BoosterIgnDelay = D("booster_ign_delay_s"),
            IncludeBooster = !(e.TryGetProperty("include_booster", out var ib) && ib.ValueKind == JsonValueKind.False),
        };
    }

    public static FlightRow From(Dictionary<string, object> d) => From(JsonSerializer.SerializeToElement(d));

    /// An array row in `fields` order, or the usual object.
    public static FlightRow From(JsonElement e, string[] fields)
    {
        if (fields == null || e.ValueKind != JsonValueKind.Array) return From(e);
        var d = new Dictionary<string, object>();
        int i = 0;
        foreach (var v in e.EnumerateArray())
        {
            if (i >= fields.Length) break;
            d[fields[i++]] = v.ValueKind switch
            {
                JsonValueKind.Number => v.GetDouble(),
                JsonValueKind.String => v.GetString(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => null,
            };
        }
        return From(d);
    }
}

sealed class FlightResult
{
    public double MaxAlt, MaxVel, TimeToApogee, TimeMaxVel, FlightTime;
    public List<global::y.c> History;
}

static class Flight
{
    static readonly MethodInfo LoadParts = Refl.StaticMethod(typeof(global::a6), "a", typeof(global::i).MakeByRefType(), typeof(global::a4));

    public static FlightResult Fly(Design design, FlightRow row, Motors motors, float dt)
    {
        var stages = design.Stages();
        int boosters = 0;
        foreach (var st in stages)
        {
            if (st.Stage == "S")
            {
                st.TotalWeight = (decimal)row.SustainerWt; st.NozzleDiameter = (decimal)row.SustainerNozzle; st.CGLoc = (decimal)row.SustainerCg;
                st.IgnitionDelay = (float)row.IgnDelay; st.EngineName = row.SustainerEngine;
            }
            else if (++boosters == 1)
            {
                st.TotalWeight = (decimal)row.CombinedWt; st.NozzleDiameter = (decimal)row.BoosterNozzle; st.CGLoc = (decimal)row.CombinedCg;
                st.SeparationDelay = (float)row.SepDelay; st.IgnitionDelay = (float)row.BoosterIgnDelay; st.EngineName = row.BoosterEngine;
            }
        }
        // the GUI drops booster 2 always (we never write one) and booster 1 when not included
        while (stages.Count > 2) stages.RemoveAt(2);
        if (stages.Count == 2 && !row.IncludeBooster) { stages.RemoveAt(1); }
        stages[0].IgnitionDelay = stages.Count == 1 ? 0f : stages[0].IgnitionDelay;
        if (stages.Count == 1) stages[0].IgnitionDelay = 0f;

        var problems = new List<string>();
        foreach (var st in stages)
        {
            if (string.IsNullOrEmpty(st.EngineName)) { problems.Add($"stage {st.Stage}: no motor name"); continue; }
            try { st.StageEngine = motors.Find(st.EngineName); }
            catch (KeyNotFoundException e) { problems.Add(e.Message); continue; }
            if (st.CGLoc <= 0m) problems.Add($"stage {st.Stage}: CG location is 0");
            if (st.TotalWeight <= 0m) problems.Add($"stage {st.Stage}: total weight is 0");
            else if ((float)st.TotalWeight < st.StageEngine.f()) problems.Add($"stage {st.Stage}: weight {st.TotalWeight} lb is below the motor's {st.StageEngine.f():F2} lb");
        }
        if (problems.Count > 0) throw new InvalidOperationException(string.Join("; ", problems));
        stages.Reverse();

        var sim = new global::y();
        var site = design.Site;
        sim.f((object)site.RodLength);
        sim.o((object)(site.RodAngle == 0f ? 0.0001 : (double)site.RodAngle));
        sim.t((object)site.WindSpeed);
        sim.c(site.Altitude, site.Pressure);
        sim.m((object)site.Temperature);
        var rec = design.Recover;
        var recEvent = Refl.Field<bool[]>(rec, "a");   // field 'a' hides behind the clone method d.a()
        if (recEvent != null && recEvent.Length >= 2 && rec.b != null && rec.d != null && rec.e != null && rec.f != null)
            sim.a(recEvent[0], rec.b[0], recEvent[1], rec.b[1], rec.d[0], rec.d[1], rec.e[1], rec.f[0], rec.f[1]);
        sim.j((object)false);   // not the demo build: no Mach 3 stop
        sim.a(true);            // "Complex Sim" (the GUI default)
        sim.p((object)dt);

        float t0 = 0f, x0 = 0f, y0 = 0f, z0 = 0f, v0 = 0f, w0 = 0f, s0 = 0f, alt0 = 0f;
        foreach (var st in stages)
        {
            var aero = Refl.Field<global::i>(sim, "g");   // field 'g' hides behind the MaxAlt getter y.g()
            var args = new object[] { aero, st };
            LoadParts.Invoke(null, args);
            aero = (global::i)args[0];
            Refl.SetField(sim, "g", aero);
            aero.n(0m);
            aero.e((object)1049);
            aero.e(0m, 0m);
            sim.i((object)t0); sim.c((object)x0); sim.q((object)y0); sim.g((object)z0); sim.r((object)v0); sim.b((object)w0); sim.e((object)s0); sim.c(alt0);
            sim.l((object)st.Stage); sim.k((object)st.TotalWeight); sim.s((object)st.StageEngine); sim.a((object)st.CGLoc);
            sim.n((object)st.SeparationDelay); sim.d((object)st.IgnitionDelay);
            sim.e();
            t0 = Convert.ToSingle(sim.y()); x0 = Convert.ToSingle(sim.m()); y0 = Convert.ToSingle(sim.q()); z0 = Convert.ToSingle(sim.r());
            v0 = Convert.ToSingle(sim.x()); w0 = Convert.ToSingle(sim.u()); s0 = Convert.ToSingle(sim.d()); alt0 = sim.i();
        }
        var hist = sim.av;
        return new FlightResult
        {
            MaxAlt = Convert.ToDouble(sim.g()), MaxVel = Convert.ToDouble(sim.v()), TimeToApogee = Convert.ToDouble(sim.s()), TimeMaxVel = Convert.ToDouble(sim.h()),
            FlightTime = hist.Count > 0 ? hist[hist.Count - 1].a : 0.0, History = hist,
        };
    }
}

static class Refl
{
    const BindingFlags All = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
    public static T Field<T>(object o, string name) => (T)o.GetType().GetField(name, All).GetValue(o);
    public static object Get(object o, string name) => FieldOf(o, name).GetValue(o);
    public static void Set(object o, string name, object value) => FieldOf(o, name).SetValue(o, value);
    static FieldInfo FieldOf(object o, string name)
    {
        for (var t = o.GetType(); t != null; t = t.BaseType)
        {
            var f = t.GetField(name, BindingFlags.DeclaredOnly | All);
            if (f != null) return f;
        }
        throw new MissingFieldException(o.GetType().Name, name);
    }
    // Instance method by name and argument count/types, tolerant of GUI overloads.
    public static object Call(object o, string name, params object[] args)
    {
        for (var t = o.GetType(); t != null; t = t.BaseType)
            foreach (var m in t.GetMethods(BindingFlags.DeclaredOnly | All))
            {
                if (m.Name != name) continue;
                ParameterInfo[] ps;
                try { ps = m.GetParameters(); } catch (Exception) { continue; }
                if (ps.Length != args.Length) continue;
                bool ok = true;
                for (int k = 0; k < ps.Length; k++) if (args[k] != null && !ps[k].ParameterType.IsInstanceOfType(args[k])) { ok = false; break; }
                if (ok) return m.Invoke(o, args);
            }
        throw new MissingMethodException(o.GetType().Name, name + "/" + args.Length);
    }
    public static void SetField(object o, string name, object value) => o.GetType().GetField(name, All).SetValue(o, value);

    // GetMethod(name, types) resolves every overload's parameter types, and
    // RASAero's GUI overloads reference WinForms, which is absent here.
    public static MethodInfo StaticMethod(Type type, string name, params Type[] parameters)
    {
        foreach (var m in type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
        {
            if (m.Name != name) continue;
            ParameterInfo[] ps;
            try { ps = m.GetParameters(); if (ps.Length != parameters.Length || !ps.Select(p => p.ParameterType).SequenceEqual(parameters)) continue; }
            catch (Exception) { continue; }
            return m;
        }
        throw new MissingMethodException($"{type.Name}.{name}({string.Join(",", parameters.Select(t => t.Name))})");
    }
}

// ---- Aero Plots table ------------------------------------------------------------

static class Aero
{
    public const string Header = "Mach,Alpha,CD,CD Power-Off,CD Power-On,CA Power-Off,CA Power-On,CL,CN,CN Potential,CN Viscous,CNalpha (0 to 4 deg) (per rad),CP,CP (0 to 4 deg),Reynolds Number";

    public static int Table(Design design, string config, double altitudeFt, double? nozzleIn, decimal machMax, decimal step, string csv)
    {
        var stages = design.Stages();
        global::a4 st = config == "sustainer" ? stages[0] : (config == "stack" ? stages[stages.Count - 1] : throw new ArgumentException("config must be stack or sustainer"));
        if (config == "stack" && stages.Count < 2) throw new InvalidOperationException("the design has no Booster part, so there is no stack configuration");
        if (nozzleIn.HasValue) st.NozzleDiameter = (decimal)nozzleIn.Value;
        var aero = new global::i();
        var args = new object[] { aero, st };
        Refl.StaticMethod(typeof(global::a6), "a", typeof(global::i).MakeByRefType(), typeof(global::a4)).Invoke(null, args);
        aero = (global::i)args[0];
        aero.n(0m);
        var ma = new List<global::bn>();
        foreach (var m in new[] { 0f, 25f }) { var pt = new global::bn(); pt.a(m, (float)altitudeFt); ma.Add(pt); }
        aero.a(ma);
        aero.e((object)1049);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(csv)));
        using var w = new StreamWriter(csv, false, new UTF8Encoding(false));
        w.WriteLine(Header);
        int n = 0;
        var res = default(global::ae);
        foreach (var alpha in new[] { 0m, 2m, 4m })
        {
            aero.n(alpha);
            for (decimal mach = 0.01m; mach <= machMax; mach += step)
            {
                aero.a(mach, -1m, ref res);
                w.WriteLine(string.Join(",", new[] { res.a, res.b, res.c, res.d, res.e, res.k, res.l, res.m, res.n, res.p, res.o, res.i, res.f, res.g, res.q }.Select(x => x.ToString(CultureInfo.InvariantCulture))));
                n++;
            }
        }
        return n;
    }
}

// ---- View Data export ---------------------------------------------------------------

static class Csv
{
    public const string Header = "Time (sec),Stage,Stage Time (sec),Mach Number,Angle of Attack (deg),CD,CL,Thrust (lb),Weight (lb),Drag (lb),Lift (lb),CG (in),CP (in),Stability Margin (cal),Accel (ft/sec^2),Accel-V (ft/sec^2),Accel-H (ft/sec^2),Velocity (ft/sec),Vel-V (ft/sec),Vel-H (ft/sec),Pitch Attitude (deg),Flight Path Angle (deg),Altitude (ft),Distance (ft)";

    public static readonly string[] HeaderCols = Header.Split(',');

    static string F(float v) => v.ToString("R", CultureInfo.InvariantCulture);
    static string D(decimal v) => v.ToString(CultureInfo.InvariantCulture);

    /// Stage letter as a number for the binary block (B=1, S=2, else 0).
    static double StageCode(string k) => k == "B" ? 1 : k == "S" ? 2 : 0;

    /// The same columns as WriteHistory as one little-endian float64 block,
    /// row-major, base64: numpy.frombuffer reads it in a millisecond.
    public static string HistoryBlock(List<global::y.c> rows, int every)
    {
        int n = (rows.Count + every - 1) / every;
        var buf = new double[n * HeaderCols.Length];
        int i = 0;
        for (int k = 0; k < rows.Count; k += every)
        {
            var r = rows[k];
            buf[i++] = r.a; buf[i++] = StageCode(r.k); buf[i++] = r.l; buf[i++] = r.j; buf[i++] = r.o; buf[i++] = r.f; buf[i++] = r.q; buf[i++] = r.i; buf[i++] = r.h; buf[i++] = r.g; buf[i++] = r.r; buf[i++] = r.t; buf[i++] = r.u; buf[i++] = r.s;
            buf[i++] = (double)r.e.c; buf[i++] = (double)r.e.b; buf[i++] = (double)r.e.a; buf[i++] = (double)r.d.c; buf[i++] = (double)r.d.b; buf[i++] = (double)r.d.a;
            buf[i++] = r.m; buf[i++] = r.n; buf[i++] = r.b; buf[i++] = r.c;
        }
        var bytes = new byte[buf.Length * sizeof(double)];
        Buffer.BlockCopy(buf, 0, bytes, 0, bytes.Length);
        if (!BitConverter.IsLittleEndian) Array.Reverse(bytes);
        return Convert.ToBase64String(bytes);
    }

    public static void WriteHistory(string path, List<global::y.c> rows, int every)
    {
        using var w = new StreamWriter(path, false, new UTF8Encoding(false));
        w.WriteLine(Header);
        for (int k = 0; k < rows.Count; k += every)
        {
            var r = rows[k];
            w.WriteLine(string.Join(",", F(r.a), r.k, F(r.l), F(r.j), F(r.o), F(r.f), F(r.q), F(r.i), F(r.h), F(r.g), F(r.r), F(r.t), F(r.u), F(r.s), D(r.e.c), D(r.e.b), D(r.e.a), D(r.d.c), D(r.d.b), D(r.d.a), F(r.m), F(r.n), F(r.b), F(r.c)));
        }
    }
}
