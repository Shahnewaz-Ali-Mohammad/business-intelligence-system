import { redirect } from 'next/navigation';

// Designed reports are listed in the left panel; there is no separate page.
export default function DesignedReportsPage() { redirect('/chat'); }
