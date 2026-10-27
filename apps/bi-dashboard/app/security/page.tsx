import { WorkspacePage } from '@/components/workspace/workspace-page';
import { SecuritySettings } from '@/components/auth/security-settings';

export default function SecurityPage() {
  return (
    <WorkspacePage active="Account" title="Account security" subtitle="Two-step sign-in with an authenticator app." scroll>
      <SecuritySettings />
    </WorkspacePage>
  );
}
