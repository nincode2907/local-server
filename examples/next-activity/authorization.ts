import 'server-only';

/** Replace with your existing session + durable user/run ownership lookup.
 * Store the run ID against the signed-in user when YOUR backend creates it.
 * Never accept an owner/user ID supplied by the browser as proof of ownership.
 * Default deny makes this example safe before the application's integration exists.
 */
export async function canAccessRun(_request:Request,_runId:string):Promise<boolean> {
  return false;
}
