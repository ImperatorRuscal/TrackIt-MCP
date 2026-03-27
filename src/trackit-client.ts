/**
 * Low-level HTTP client for the Track-It 2021 WebAPI.
 *
 * Key quirks encoded here:
 * - Create  = POST /tickets
 * - Update  = POST /tickets/{id}          (not PUT/PATCH)
 * - Delete  = POST /tickets/{id}/Delete   (not DELETE)
 * - Pagination is path segments:  /{pageSize}/{pageNumber}  (0/0 = all)
 * - Field names have spaces: "Assigned Tech", "Note Type", etc.
 * - "priorityheirarchy" — intentional typo in the API
 */

import * as https from "https";
import * as http from "http";
import { getAccessToken, invalidateToken } from "./auth.js";

function getBaseUrl(): string {
  const url = process.env.TRACKIT_BASE_URL;
  if (!url) throw new Error("TRACKIT_BASE_URL not set");
  // Strip trailing slash if present
  return url.replace(/\/$/, "");
}

function makeRequest(
  method: string,
  url: string,
  body: unknown | null,
  token: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const bodyStr = body !== null ? JSON.stringify(body) : undefined;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(bodyStr
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(bodyStr),
            }
          : {}),
      },
    };
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function apiCall(
  method: string,
  path: string,
  body: unknown | null = null
): Promise<unknown> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;
  let token = await getAccessToken();
  let response = await makeRequest(method, url, body, token);

  if (response.status === 401) {
    invalidateToken();
    token = await getAccessToken();
    response = await makeRequest(method, url, body, token);
  }

  if (response.status >= 400) {
    throw new Error(
      `Track-It API error ${response.status} on ${method} ${path}: ${response.body}`
    );
  }

  if (!response.body || response.body.trim() === "") return null;
  try {
    return JSON.parse(response.body);
  } catch {
    return response.body;
  }
}

// ─── Tickets ─────────────────────────────────────────────────────────────────

export function createTicket(properties: Record<string, unknown>, optionalParams?: Record<string, unknown>) {
  return apiCall("POST", "/tickets", { Properties: properties, OptionalParams: optionalParams ?? {} });
}

export function getTicket(id: number) {
  return apiCall("GET", `/tickets/${id}`);
}

export function updateTicket(id: number, properties: Record<string, unknown>, optionalParams?: Record<string, unknown>) {
  return apiCall("POST", `/tickets/${id}`, { Properties: properties, OptionalParams: optionalParams ?? {} });
}

export function deleteTicket(id: number) {
  return apiCall("POST", `/tickets/${id}/Delete`);
}

export function changeTicketStatus(id: number, statusName: string, note?: Record<string, unknown>) {
  return apiCall("POST", `/tickets/${id}/ChangeStatus`, { StatusName: statusName, ...(note ? { Note: note } : {}) });
}

export function closeTicket(id: number, note?: Record<string, unknown>) {
  return apiCall("POST", `/tickets/${id}/Close`, note ? { Note: note } : {});
}

export function getTicketNotes(id: number, maxContentLength?: number, systemNote?: boolean) {
  const params = new URLSearchParams();
  if (maxContentLength !== undefined) params.set("maxContentLength", String(maxContentLength));
  if (systemNote !== undefined) params.set("SystemNote", String(systemNote));
  const qs = params.toString() ? `?${params.toString()}` : "";
  return apiCall("GET", `/tickets/${id}/Notes/0/0${qs}`);
}

export function getTicketNote(noteId: number) {
  return apiCall("GET", `/tickets/Note/${noteId}`);
}

export function addTicketNote(id: number, note: Record<string, unknown>) {
  return apiCall("POST", `/tickets/${id}/AddNote`, note);
}

export function getTicketAttachments(id: number) {
  return apiCall("GET", `/tickets/${id}/Attachments/0/0`);
}

export function getTicketAssignments(id: number) {
  return apiCall("GET", `/tickets/${id}/Assignments/0/0`);
}

export function getTicketTemplates() {
  return apiCall("GET", "/tickets/Templates");
}

// ─── Assignments ─────────────────────────────────────────────────────────────

export function createAssignment(properties: Record<string, unknown>, optionalParams?: Record<string, unknown>) {
  return apiCall("POST", "/assignments", { Properties: properties, OptionalParams: optionalParams ?? {} });
}

export function getAssignment(id: number) {
  return apiCall("GET", `/assignments/${id}`);
}

export function updateAssignment(id: number, properties: Record<string, unknown>, optionalParams?: Record<string, unknown>) {
  return apiCall("POST", `/assignments/${id}`, { Properties: properties, OptionalParams: optionalParams ?? {} });
}

export function deleteAssignment(id: number) {
  return apiCall("POST", `/assignments/${id}/Delete`);
}

export function changeAssignmentStatus(id: number, statusName: string, note?: Record<string, unknown>) {
  return apiCall("POST", `/assignments/${id}/ChangeStatus`, { StatusName: statusName, ...(note ? { Note: note } : {}) });
}

export function closeAssignment(id: number, note?: Record<string, unknown>) {
  return apiCall("POST", `/assignments/${id}/Close`, note ? { Note: note } : {});
}

export function getAssignmentNotes(id: number, maxContentLength?: number, systemNote?: boolean) {
  const params = new URLSearchParams();
  if (maxContentLength !== undefined) params.set("maxContentLength", String(maxContentLength));
  if (systemNote !== undefined) params.set("SystemNote", String(systemNote));
  const qs = params.toString() ? `?${params.toString()}` : "";
  return apiCall("GET", `/assignments/${id}/Notes/0/0${qs}`);
}

export function getAssignmentNote(noteId: number) {
  return apiCall("GET", `/assignments/Note/${noteId}`);
}

export function addAssignmentNote(id: number, note: Record<string, unknown>) {
  return apiCall("POST", `/assignments/${id}/AddNote`, note);
}

export function getAssignmentAttachments(id: number) {
  return apiCall("GET", `/assignments/${id}/Attachments/0/0`);
}

export function getAssignmentPredecessors(id: number) {
  return apiCall("GET", `/assignments/${id}/Predecessors/0/0`);
}

export function getAssignmentSuccessors(id: number) {
  return apiCall("GET", `/assignments/${id}/Successors/0/0`);
}

export function getAssignmentTemplates() {
  return apiCall("GET", "/assignments/Templates");
}

// ─── Solutions ───────────────────────────────────────────────────────────────

export function getSolution(id: number) {
  return apiCall("GET", `/solutions/${id}`);
}

export function getSolutionAttachments(id: number) {
  return apiCall("GET", `/solutions/${id}/Attachments/0/0`);
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

export function getAttachment(attachmentId: number) {
  return apiCall("GET", `/attachment/${attachmentId}`);
}

export function getModuleFields(moduleSequence: number) {
  return apiCall("GET", `/module/${moduleSequence}/fields`);
}

export function search(
  term: string,
  moduleId?: number,
  pageSize = 25,
  pageNumber = 0,
  maxContentLength = 500
) {
  return apiCall("POST", "/searches", {
    Term: term,
    ...(moduleId !== undefined ? { ModuleId: moduleId } : {}),
    Mode: 0,
    PageSize: pageSize,
    PageNumber: pageNumber,
    MaxContentLength: maxContentLength,
  });
}

export function getPriorityHierarchy(
  departmentId?: number,
  categoryId?: number,
  locationId?: number,
  requestorId?: number
) {
  // Intentional typo: "heirarchy" not "hierarchy"
  // API takes integer IDs, not name strings
  return apiCall("POST", "/priorityheirarchy", {
    ...(departmentId !== undefined ? { DepartmentId: departmentId } : {}),
    ...(categoryId !== undefined ? { CategoryId: categoryId } : {}),
    ...(locationId !== undefined ? { LocationId: locationId } : {}),
    ...(requestorId !== undefined ? { RequestorId: requestorId } : {}),
  });
}
