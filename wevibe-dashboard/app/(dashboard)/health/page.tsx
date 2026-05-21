import Link from 'next/link';

type ServiceStatus = {
  name: string;
  healthy: boolean;
  ms: number;
  error?: string;
};

async function checkService(
  name: string,
  url: string,
  validate?: (data: any) => boolean
): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const resp = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const elapsed = Date.now() - start;
    if (!resp.ok) return { name, healthy: false, ms: elapsed, error: `HTTP ${resp.status}` };
    if (validate) {
      const data = await resp.json();
      const valid = validate(data);
      return { name, healthy: valid, ms: elapsed, error: valid ? undefined : 'validation failed' };
    }
    return { name, healthy: true, ms: elapsed };
  } catch (e) {
    return { name, healthy: false, ms: Date.now() - start, error: e instanceof Error ? e.message : 'unreachable' };
  }
}

export default async function HealthPage() {
  const timestamp = new Date().toISOString();

  const [pg, qdrant, chain, hub, mcp, ollama] = await Promise.all([
    checkService('PostgreSQL (via Hub)', 'http://localhost:4440/health', (d) => d.status === 'ok' && d.db === 'connected'),
    checkService('Qdrant', 'http://localhost:6333/healthz'),
    checkService('wevibe-chain', 'http://localhost:26657/status'),
    checkService('wevibe-hub', 'http://localhost:4440/health', (d) => d.status === 'ok'),
    checkService('wevibe-mcp HTTP', 'http://127.0.0.1:4450/v1/health', (d) => d.status === 'ok'),
    checkService('Ollama', 'http://localhost:11434/api/tags'),
  ]);

  const dashboard: ServiceStatus = { name: 'Dashboard', healthy: true, ms: 0 };

  const allServices = [dashboard, pg, qdrant, chain, hub, mcp, ollama];
  const allHealthy = allServices.every((s) => s.healthy);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Pipeline Health</h1>
          <p className="mt-1 text-sm text-gray-500">
            Last checked: {timestamp}
          </p>
        </div>
        <Link
          href="/health"
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
        >
          Refresh
        </Link>
      </div>

      <div
        className={`rounded-lg p-4 ${
          allHealthy ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
        }`}
      >
        <div className="flex items-center gap-3">
          <span
            className={`w-3 h-3 rounded-full ${allHealthy ? 'bg-green-500' : 'bg-red-500'}`}
          />
          <span className={`text-lg font-medium ${allHealthy ? 'text-green-800' : 'text-red-800'}`}>
            {allHealthy ? 'All systems operational' : 'System degradation detected'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {allServices.map((service) => (
          <div
            key={service.name}
            className="rounded-lg border p-4 bg-white"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-gray-900">{service.name}</span>
              <span
                className={`w-2.5 h-2.5 rounded-full ${service.healthy ? 'bg-green-500' : 'bg-red-500'}`}
              />
            </div>
            <div className="mt-2 text-sm text-gray-500">
              {service.healthy ? (
                <span>{service.ms}ms</span>
              ) : (
                <span className="text-red-600">{service.error || 'unreachable'}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
