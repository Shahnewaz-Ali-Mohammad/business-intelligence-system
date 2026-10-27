import { WorkspacePage } from '@/components/workspace/workspace-page';
import { AdminConsole } from '@/components/admin/admin-console';

export default function AdminPage() {
  return (
    <WorkspacePage active="Admin" title="Admin" subtitle="People, roles, departments, workspace access and the audit log." scroll>
      <AdminConsole />
    </WorkspacePage>
  );
}
