import Sidebar from '@/components/layout/sidebar';
import Topbar from '@/components/layout/topbar';
import { OrgProvider } from '@/lib/org-context';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <OrgProvider>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex flex-col flex-1 overflow-hidden">
          <Topbar />
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </div>
      </div>
    </OrgProvider>
  );
}
