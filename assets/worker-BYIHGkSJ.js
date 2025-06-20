class PreswaldWorker {
  constructor() {
    this.pyodide = null;
    this.isInitialized = false;
    this.activeScriptPath = null;
    this.components = {};
  }

  async initializePyodide() {
    try {
      const pyodideLoader = await import("https://cdn.jsdelivr.net/pyodide/v0.27.2/full/pyodide.mjs");
      this.pyodide = await pyodideLoader.loadPyodide({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/"
      });

      // Flag for browser mode
      this.pyodide.runPython(`
        import js
        js.window.__PRESWALD_BROWSER_MODE = True
      `);

      // Set working directory
      await this.pyodide.runPythonAsync(`
        import os
        os.makedirs('/project', exist_ok=True)
        os.chdir('/project')
      `);

      // Backend setup
      await this.pyodide.loadPackage(["micropip", "matplotlib"]);
      await this.pyodide.runPythonAsync(`
        import micropip
        await micropip.install("duckdb")
        await micropip.install("preswald")

        with open("/matplotlibrc", "w") as f:
          f.write("backend: agg\\n")

        import matplotlib
        matplotlib.use("agg")
      `);

      await this.pyodide.runPythonAsync(`
        import preswald.browser.entrypoint
      `);

      this.isInitialized = true;
      return { success: true };
    } catch (error) {
      console.error("[Worker] Initialization error:", error);
      throw error;
    }
  }

  // ✅ MOUNT project_fs.json files into Pyodide FS
  async mountProjectFiles() {
    try {
      const res = await fetch("./project_fs.json");
      const files = await res.json();

      for (const [path, file] of Object.entries(files)) {
        const fullPath = `/project/${path.replace(/\\/g, "/")}`;
        const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));

        await this.pyodide.runPythonAsync(`import os; os.makedirs("${dir}", exist_ok=True)`);

        if (file.type === "text") {
          this.pyodide.FS.writeFile(fullPath, file.content);
        } else if (file.type === "binary") {
          const bytes = Uint8Array.from(atob(file.content), c => c.charCodeAt(0));
          this.pyodide.FS.writeFile(fullPath, bytes);
        }
      }

      console.log("[Worker] Project files mounted.");
    } catch (err) {
      console.error("[Worker] mountProjectFiles failed:", err);
      throw err;
    }
  }

  async runScript(path) {
    if (!this.isInitialized) throw new Error("Pyodide not initialized");

    await this.mountProjectFiles(); // ✅ Make sure files exist in Pyodide FS

    try {
      this.activeScriptPath = path;

      const result = await self.preswaldRunScript(path);
      const jsResult = result.toJs();

      if (!jsResult.success) throw new Error(jsResult.error || "Script execution failed");

      const componentJSON = await this.pyodide.runPythonAsync(`
        import json
        from preswald.browser.virtual_service import VirtualPreswaldService
        service = VirtualPreswaldService.get_instance()
        components = service.get_rendered_components()
        json.dumps(components)
      `);

      this.components = JSON.parse(componentJSON);
      return { success: true, components: this.components };
    } catch (err) {
      console.error("[Worker] runScript error:", err);
      throw err;
    }
  }
}

const workerInstance = new PreswaldWorker();
_(workerInstance); // bind Comlink listener
