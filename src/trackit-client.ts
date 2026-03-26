/**
 * Typed HTTP client for the BMC Track-It 2021 WebAPI.
 *
 * All methods accept a bearerToken and return the parsed JSON body.
 * The API returns fields as generic key-value sequences, so most response
 * types are Record<string, unknown> — the LLM reads the field names directly.
 */

import axios, { AxiosInstance, AxiosResponse } from "axios";

// ---------------------------------------------------------------------------
// Input DTO types (mirroring the Swagger definitions)
// ---------------------------------------------------------------------------

export interface NoteDto {
  "Note Type"?: string;
  "Activity Code"?: string;
  Note?: string;
  Duration?: string;
  Private?: boolean;
}

export interface CreateInputDto {
  Properties: Record<string, unknown>;
  OptionalParams?: { Param1?: unknown; Param2?: unknown };
}

export interface UpdateTicketInputDto {
  Properties: Record<string, unknown>;
  OptionalParams?: { Param1?: unknown; Param2?: unknown; Note?: NoteDto };
}

export interface UpdateAssignmentInputDto {
  Properties: Record<string, unknown>;
  OptionalParams?: { Param1?: unknown; Param2?: unknown; Note?: NoteDto };
}

export interface ChangeStatusInputDto {
  StatusName: string;
  Note?: NoteDto;
}

export interface CloseInputDto {
  Note?: NoteDto;
}

export interface SearchInputDto {
  Term: string;
  ModuleId?: number;
  Mode?: number;
  PageSize?: number;
  PageNumber?: number;
  MaxContentLength?: number;
  ResultFields?: number[];
  OptionalParams?: Record<string, unknown>;
}

export interface PriorityHierarchyInputDto {
  DepartmentId?: number;
  CategoryId?: number;
  LocationId?: number;
  RequestorId?: number;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function makeClient(bearerToken: string): AxiosInstance {
  return axios.create({
    baseURL: process.env.TRACKIT_BASE_URL,
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

function data<T>(res: AxiosResponse<T>): T {
  return res.data;
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export async function createTicket(
  token: string,
  input: CreateInputDto
): Promise<unknown> {
  return data(await makeClient(token).post("/tickets", input));
}

export async function getTicket(token: string, id: number): Promise<unknown> {
  return data(await makeClient(token).get(`/tickets/${id}`));
}

export async function updateTicket(
  token: string,
  id: number,
  input: UpdateTicketInputDto
): Promise<unknown> {
  return data(await makeClient(token).post(`/tickets/${id}`, input));
}

export async function getTicketTemplates(token: string): Promise<unknown> {
  return data(await makeClient(token).get("/tickets/Templates"));
}

export async function getTicketNotes(
  token: string,
  id: number,
  pageSize = 0,
  pageNumber = 0,
  maxContentLength?: number,
  systemNote?: boolean
): Promise<unknown> {
  const params: Record<string, unknown> = {};
  if (maxContentLength !== undefined) params.maxContentLength = maxContentLength;
  if (systemNote !== undefined) params.SystemNote = systemNote;
  return data(
    await makeClient(token).get(
      `/tickets/${id}/Notes/${pageSize}/${pageNumber}`,
      { params }
    )
  );
}

export async function getTicketNoteById(
  token: string,
  noteId: number
): Promise<unknown> {
  return data(await makeClient(token).get(`/tickets/Note/${noteId}`));
}

export async function addTicketNote(
  token: string,
  id: number,
  note: NoteDto
): Promise<unknown> {
  return data(await makeClient(token).post(`/tickets/${id}/AddNote`, note));
}

export async function getTicketAttachments(
  token: string,
  id: number,
  pageSize = 0,
  pageNumber = 0
): Promise<unknown> {
  return data(
    await makeClient(token).get(
      `/tickets/${id}/Attachments/${pageSize}/${pageNumber}`
    )
  );
}

export async function getTicketAssignments(
  token: string,
  id: number,
  pageSize = 0,
  pageNumber = 0
): Promise<unknown> {
  return data(
    await makeClient(token).get(
      `/tickets/${id}/Assignments/${pageSize}/${pageNumber}`
    )
  );
}

export async function changeTicketStatus(
  token: string,
  id: number,
  input: ChangeStatusInputDto
): Promise<unknown> {
  return data(
    await makeClient(token).post(`/tickets/${id}/ChangeStatus`, input)
  );
}

export async function closeTicket(
  token: string,
  id: number,
  input?: CloseInputDto
): Promise<unknown> {
  return data(
    await makeClient(token).post(`/tickets/${id}/Close`, input ?? {})
  );
}

export async function deleteTicket(
  token: string,
  id: number
): Promise<unknown> {
  return data(await makeClient(token).post(`/tickets/${id}/Delete`));
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function createAssignment(
  token: string,
  input: CreateInputDto
): Promise<unknown> {
  return data(await makeClient(token).post("/assignments", input));
}

export async function getAssignment(
  token: string,
  id: number
): Promise<unknown> {
  return data(await makeClient(token).get(`/assignments/${id}`));
}

export async function updateAssignment(
  token: string,
  id: number,
  input: UpdateAssignmentInputDto
): Promise<unknown> {
  return data(await makeClient(token).post(`/assignments/${id}`, input));
}

export async function getAssignmentTemplates(token: string): Promise<unknown> {
  return data(await makeClient(token).get("/assignments/Templates"));
}

export async function getAssignmentNotes(
  token: string,
  id: number,
  pageSize = 0,
  pageNumber = 0,
  maxContentLength?: number,
  systemNote?: boolean
): Promise<unknown> {
  const params: Record<string, unknown> = {};
  if (maxContentLength !== undefined) params.maxContentLength = maxContentLength;
  if (systemNote !== undefined) params.SystemNote = systemNote;
  return data(
    await makeClient(token).get(
      `/assignments/${id}/Notes/${pageSize}/${pageNumber}`,
      { params }
    )
  );
}

export async function getAssignmentNoteById(
  token: string,
  noteId: number
): Promise<unknown> {
  return data(await makeClient(token).get(`/assignments/Note/${noteId}`));
}

export async function addAssignmentNote(
  token: string,
  id: number,
  note: NoteDto
): Promise<unknown> {
  return data(
    await makeClient(token).post(`/assignments/${id}/AddNote`, note)
  );
}

export async function getAssignmentAttachments(
  token: string,
  id: number,
  pageSize = 0,
  pageNumber = 0
): Promise<unknown> {
  return data(
    await makeClient(token).get(
      `/assignments/${id}/Attachments/${pageSize}/${pageNumber}`
    )
  );
}

export async function changeAssignmentStatus(
  token: string,
  id: number,
  input: ChangeStatusInputDto
): Promise<unknown> {
  return data(
    await makeClient(token).post(`/assignments/${id}/ChangeStatus`, input)
  );
}

export async function closeAssignment(
  token: string,
  id: number,
  input?: CloseInputDto
): Promise<unknown> {
  return data(
    await makeClient(token).post(`/assignments/${id}/Close`, input ?? {})
  );
}

export async function deleteAssignment(
  token: string,
  id: number
): Promise<unknown> {
  return data(await makeClient(token).post(`/assignments/${id}/Delete`));
}

export async function getAssignmentPredecessors(
  token: string,
  id: number,
  pageSize = 0,
  pageNumber = 0
): Promise<unknown> {
  return data(
    await makeClient(token).get(
      `/assignments/${id}/Predecessors/${pageSize}/${pageNumber}`
    )
  );
}

export async function getAssignmentSuccessors(
  token: string,
  id: number,
  pageSize = 0,
  pageNumber = 0
): Promise<unknown> {
  return data(
    await makeClient(token).get(
      `/assignments/${id}/Successors/${pageSize}/${pageNumber}`
    )
  );
}

// ---------------------------------------------------------------------------
// Solutions
// ---------------------------------------------------------------------------

export async function getSolution(
  token: string,
  solutionId: number
): Promise<unknown> {
  return data(await makeClient(token).get(`/solutions/${solutionId}`));
}

export async function getSolutionAttachments(
  token: string,
  id: number,
  pageSize = 0,
  pageNumber = 0
): Promise<unknown> {
  return data(
    await makeClient(token).get(
      `/solutions/${id}/Attachments/${pageSize}/${pageNumber}`
    )
  );
}

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

export async function getAttachment(
  token: string,
  attachmentId: number
): Promise<unknown> {
  return data(await makeClient(token).get(`/attachment/${attachmentId}`));
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export async function getModuleFields(
  token: string,
  moduleSequence: number
): Promise<unknown> {
  return data(
    await makeClient(token).get(`/module/${moduleSequence}/fields`)
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function search(
  token: string,
  input: SearchInputDto
): Promise<unknown> {
  return data(await makeClient(token).post("/searches", input));
}

// ---------------------------------------------------------------------------
// Priority Hierarchy
// ---------------------------------------------------------------------------

export async function getPriorityHierarchy(
  token: string,
  input: PriorityHierarchyInputDto
): Promise<unknown> {
  return data(await makeClient(token).post("/priorityheirarchy", input));
}

// ---------------------------------------------------------------------------
// Technician
// ---------------------------------------------------------------------------

export async function logout(token: string): Promise<unknown> {
  return data(await makeClient(token).get("/technicians/logout"));
}
