import { createContext, useContext } from "react";
import type { View, Contact, Company, Deal, Stats, PaginatedState, StageDef, Activity, ConnectionStatus, EntityType, CustomFieldDef, ImportRow, ImportEntity, ImportResult } from "./types";

export interface CrmContextValue {
  isAgent: boolean;
  stats: Stats;

  // Contacts
  contacts: Contact[];
  contactsPag: PaginatedState;
  setContactsPage: (page: number) => void;
  setContactsSort: (col: string) => void;
  setContactsSearch: (search: string) => void;
  setContactsFilters: (filters: PaginatedState["filters"]) => void;
  addContact: (data: Partial<Contact>) => Promise<void>;
  updateContact: (id: string, data: Partial<Contact>) => Promise<void>;
  deleteContact: (id: string) => Promise<void>;
  fetchContact: (id: string) => Promise<Contact | null>;
  fetchCompany: (id: string) => Promise<Company | null>;

  // Companies
  companies: Company[];
  companiesPag: PaginatedState;
  setCompaniesPage: (page: number) => void;
  setCompaniesSort: (col: string) => void;
  setCompaniesSearch: (search: string) => void;
  setCompaniesFilters: (filters: PaginatedState["filters"]) => void;
  addCompany: (data: Partial<Company>) => Promise<void>;
  updateCompany: (id: string, data: Partial<Company>) => Promise<void>;
  deleteCompany: (id: string) => Promise<void>;

  // Deals
  deals: Deal[];
  dealsPag: PaginatedState;
  dealsTotalValue: number;
  setDealsPage: (page: number) => void;
  setDealsSort: (col: string) => void;
  setDealsSearch: (search: string) => void;
  addDeal: (data: Partial<Deal>) => Promise<void>;
  updateDeal: (id: string, data: Partial<Deal>) => Promise<void>;
  deleteDeal: (id: string) => Promise<void>;
  boardDeals: Deal[];

  // Integrations (Clawnify connections)
  connections: ConnectionStatus;
  emailContact: (contactId: string, subject: string, body: string) => Promise<void>;
  scheduleMeeting: (contactId: string, data: { summary: string; start_datetime: string; timezone: string; duration_minutes: number }) => Promise<void>;

  // Activity timeline
  fetchActivities: (entityType: EntityType, entityId: string) => Promise<Activity[]>;
  addNote: (entityType: EntityType, entityId: string, body: string) => Promise<void>;

  // Contact import (CSV / XLSX)
  importEntity: (entity: ImportEntity, rows: ImportRow[], opts?: { inferCompanyFromEmail?: boolean }) => Promise<ImportResult>;

  // Custom properties (field definitions, shared across screens)
  customFields: CustomFieldDef[];
  refetchCustomFields: () => Promise<void>;

  // Pipeline stages (data-driven vocabulary, ordered by position)
  stages: StageDef[];
  refetchStages: () => Promise<void>;
  refetchBoard: () => Promise<void>;
  refetchStats: () => Promise<void>;

  loading: boolean;
  error: string | null;
  setError: (msg: string | null) => void;
}

export const CrmContext = createContext<CrmContextValue>(null!);

export function useCrm() {
  return useContext(CrmContext);
}

// The current view is derived from the URL route, not context.
export type { View };
