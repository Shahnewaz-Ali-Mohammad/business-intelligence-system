// Shared conversation routing for the original and database workspaces.
export function decideEntryRoute({ scope, needsData }) {
  if (!scope.inScope && !needsData.needsDataLookup) return { route: 'out_of_scope' };
  if (scope.isGreetingOrMeta && !needsData.needsDataLookup) return { route: 'greeting' };
  return { route: 'agent' };
}
