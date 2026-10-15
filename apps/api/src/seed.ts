import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Store } from './store.ts';
import { approve, createBrief, createDeliverable, createProject, submit, addComment } from './domain.ts';
import type { Identity } from '../../../packages/shared/src/index.ts';

const store = new Store(process.env.ACCORD_DATABASE ?? '.local/accord.sqlite');
if (store.users().length) {
  console.log('Already seeded; existing records and passwords were preserved.');
  store.close();
} else {
  const users: Identity[] = [
    { id: 'owner-maya', name: 'Maya Chen', email: 'maya@accord.local', role: 'owner', workspaceId: 'studio-north' },
    { id: 'client-alex', name: 'Alex Morgan', email: 'alex@accord.local', role: 'client', workspaceId: 'studio-north' },
    { id: 'client-jules', name: 'Jules Park', email: 'jules@accord.local', role: 'client', workspaceId: 'studio-north' },
  ];
  const accounts = users.map(user => ({ ...user, password: randomBytes(15).toString('base64url') }));
  mkdirSync('.local', { recursive: true, mode: 0o700 });
  // Never overwrite credentials for an existing seed or print passwords into logs.
  if (existsSync('.local/demo-accounts.json')) throw new Error('Credential file exists with an empty database. Move it aside before explicitly reseeding.');
  writeFileSync('.local/demo-accounts.json', JSON.stringify(accounts, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  store.transaction(() => {
    accounts.forEach(account => { const { password, ...user } = account; store.addUser(user, password); });
    const [owner, alex, jules] = users;
    for (const [client, title, description] of [[alex, 'Atlas reporting portal', 'A focused reporting workspace for the Atlas operations team.'], [jules, 'Fieldwork studio website', 'A portfolio and enquiry experience for an independent design studio.']] as const) {
      const project = createProject(store, owner, { title, description, clientId: client.id });
      const paragraphs = client.id === alex.id ? [
        { id: 'p-overview', text: 'Build a responsive reporting portal with a dashboard, date filtering, and manual CSV exports.' },
        { id: 'p-revisions', text: 'Two rounds of copy and visual revisions to the delivered screens are included. Export button labels may be adjusted during review.' },
        { id: 'p-exclusions', text: 'Scheduled reports, automated email delivery, and third-party integrations are outside this engagement.' },
      ] : [
        { id: 'p-overview', text: 'Design and build a five-page portfolio website: home, work, project detail, about, and contact.' },
        { id: 'p-revisions', text: 'One review round covers copy and layout revisions. The contact form sends enquiries to the studio.' },
        { id: 'p-exclusions', text: 'Online payments, client accounts, and booking calendars are excluded.' },
      ];
      const brief = createBrief(store, owner, project.id, { paragraphs, expectedVersion: 0 });
      submit(store, owner, project.id, 'briefs', 'brief', 1, { expectedVersion: 1 });
      approve(store, client, project.id, { targetType: 'brief', targetId: 'brief', version: 1, hash: brief.hash, decision: 'approve', expectedScopeRevision: 0 });
      const deliverable = createDeliverable(store, owner, project.id, { title: client.id === alex.id ? 'Reporting dashboard' : 'Portfolio home page', description: client.id === alex.id ? 'Dashboard layout, date filters, and manual export controls.' : 'Selected work, studio introduction, and enquiry link.', acceptanceCriteria: client.id === alex.id ? 'Date filters update the summary. Export downloads a CSV for the selected period. Layout works on desktop and mobile.' : 'Selected projects link to their detail pages. Contact link works. Layout adapts to desktop and mobile.' });
      submit(store, owner, project.id, 'deliverables', deliverable.id, 1, { expectedVersion: 1 });
      addComment(store, client, project.id, { deliverableId: deliverable.id, body: client.id === alex.id ? 'Please change the export button label to “Download CSV”, and add scheduled weekly exports.' : 'Could we make the project images larger and adjust the studio introduction?' });
    }
  });
  console.log('Seeded two isolated projects. Local login details: .local/demo-accounts.json');
  store.close();
}
