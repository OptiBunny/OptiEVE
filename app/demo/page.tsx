'use client';

import ManufacturingPanel from '../manufacturing-panel';
import Link from 'next/link';

/** No ConnectionPanel, connection status reader, account request or persistence. */
export default function DemoPage() {
  return <main className="manufacturing-demo-shell"><header className="manufacturing-demo-header"><strong>OptiEVE</strong><Link href="/" prefetch={false}>Back to app</Link></header><ManufacturingPanel characters={[]} openConnections={() => {}} demo /></main>;
}
