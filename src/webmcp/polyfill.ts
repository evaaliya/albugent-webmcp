export function isWebMCPSupported(): boolean {
    return typeof window !== 'undefined' && 'modelContext' in document;
  }
  
  export function initWebMCPPolyfill(): void {
    if (isWebMCPSupported()) {
      console.log('[Albugent WebMCP] Native document.modelContext detected.');
      return;
    }
  
    console.warn('[Albugent WebMCP] Native WebMCP is not present. Injecting Polyfill...');
  
    const registeredToolsMap = new Map<string, any>();
  
    (document as any).modelContext = {
      registerTool: (
        toolConfig: { name: string; description: string; inputSchema?: any; execute: Function }, 
        options?: { signal?: AbortSignal }
      ) => {
        registeredToolsMap.set(toolConfig.name, toolConfig);
        console.log(`[WebMCP Polyfill] Tool registered: "${toolConfig.name}"`);
  
        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            registeredToolsMap.delete(toolConfig.name);
            console.log(`[WebMCP Polyfill] Tool unregistered: "${toolConfig.name}"`);
          });
        }
      },
  
      // ВОТ ЭТОГО МЕТОДА НЕ ХВАТАЛО:
      __callTool: async (name: string, args: any) => {
        const tool = registeredToolsMap.get(name);
        if (!tool) {
          throw new Error(`Tool ${name} not registered in WebMCP Polyfill`);
        }
        return await tool.execute(args);
      },
  
      __getRegisteredTools: () => Array.from(registeredToolsMap.values())
    };
  }