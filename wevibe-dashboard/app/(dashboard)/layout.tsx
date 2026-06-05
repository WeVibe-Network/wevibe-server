import Sidebar from '@/components/layout/sidebar';
import TabNav from '@/components/layout/tab-nav';
import Topbar from '@/components/layout/topbar';
import { OrgProvider } from '@/lib/org-context';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <OrgProvider>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar />
          <TabNav />
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </div>
      </div>
    </OrgProvider>
  );
}
