import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiClient';

export interface TableInfo {
  TABLE_NAME: string;
  TABLE_ROWS: number;
  CURRENT_ROWS?: number;
}

export interface ColumnInfo {
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_KEY: string;
  COLUMN_DEFAULT: string | null;
  EXTRA: string;
}

export interface SchemaResponse {
  table: string;
  columns: ColumnInfo[];
  row_count: number;
}

export interface DataResponse {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export interface QueryResponse {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  elapsed_seconds: number;
}

export interface ColumnMeta {
  name: string;
  type: string;
  key: string;   // PRI, MUL, UNI, or ''
  nullable: string;
}

export interface IndexMeta {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface TableMeta {
  columns: ColumnMeta[];
  indexes: IndexMeta[];
}

const PAGE_SIZE = 100;

export function useExplorer() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [schema, setSchema] = useState<SchemaResponse | null>(null);
  const [data, setData] = useState<DataResponse | null>(null);
  const [isLoadingTables, setIsLoadingTables] = useState(true);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [offset, setOffset] = useState(0);
  const [allSchemas, setAllSchemas] = useState<Record<string, string[]>>({});
  const [tableMetadata, setTableMetadata] = useState<Record<string, TableMeta>>({});

  const refreshMetadata = useCallback(async (silent = false) => {
    if (!silent) setIsLoadingTables(true);
    try {
      const [tablesRes, metaRes] = await Promise.all([
        apiFetch('/api/tables'),
        apiFetch('/api/metadata/all'),
      ]);
      if (!tablesRes.ok) throw new Error(await tablesRes.text());
      const tablesJson = await tablesRes.json();
      setTables(tablesJson.tables);
      if (metaRes.ok) {
        const metaJson = await metaRes.json();
        const meta: Record<string, TableMeta> = metaJson.metadata;
        setTableMetadata(meta);
        const schemas: Record<string, string[]> = {};
        for (const [tbl, m] of Object.entries(meta)) {
          schemas[tbl] = m.columns.map(c => c.name);
        }
        setAllSchemas(schemas);
      }
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load tables');
    } finally {
      if (!silent) setIsLoadingTables(false);
    }
  }, []);

  useEffect(() => { refreshMetadata(); }, [refreshMetadata]);

  // Load schema + data when table/sort/offset changes
  const loadTableData = useCallback(async (
    table: string, sort: string, order: string, off: number
  ) => {
    setIsLoadingData(true);
    try {
      let dataUrl = `/api/tables/${table}/data?limit=${PAGE_SIZE}&offset=${off}`;
      if (sort) dataUrl += `&sort=${sort}&order=${order}`;

      const [schemaRes, dataRes] = await Promise.all([
        apiFetch(`/api/tables/${table}/schema`),
        apiFetch(dataUrl),
      ]);

      if (!schemaRes.ok) throw new Error(await schemaRes.text());
      if (!dataRes.ok) throw new Error(await dataRes.text());

      const schemaData: SchemaResponse = await schemaRes.json();
      setSchema(schemaData);
      setData(await dataRes.json());
      // Update sidebar with exact row count from COUNT(*)
      setTables(prev => prev.map(t =>
        t.TABLE_NAME === table ? { ...t, TABLE_ROWS: schemaData.row_count } : t
      ));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setIsLoadingData(false);
    }
  }, []);

  const selectTable = useCallback((name: string) => {
    setActiveTable(name);
    setSortCol('');
    setSortOrder('asc');
    setOffset(0);
    loadTableData(name, '', 'asc', 0);
  }, [loadTableData]);

  const toggleSort = useCallback((col: string) => {
    if (!activeTable) return;
    const newOrder = sortCol === col && sortOrder === 'asc' ? 'desc' : 'asc';
    const newCol = col;
    setSortCol(newCol);
    setSortOrder(newOrder);
    setOffset(0);
    loadTableData(activeTable, newCol, newOrder, 0);
  }, [activeTable, sortCol, sortOrder, loadTableData]);

  const paginate = useCallback((direction: 1 | -1) => {
    if (!activeTable) return;
    const newOffset = Math.max(0, offset + direction * PAGE_SIZE);
    setOffset(newOffset);
    loadTableData(activeTable, sortCol, sortOrder, newOffset);
  }, [activeTable, offset, sortCol, sortOrder, loadTableData]);

  const runQuery = useCallback(async (sql: string): Promise<QueryResponse> => {
    const res = await apiFetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
    if (!res.ok) {
      // Body may be JSON (`{detail: "..."}`) or plain text. statusText is
      // empty under HTTP/2, so always fall back to a non-empty message —
      // otherwise the UI treats the failure as no-error and hides it.
      const raw = await res.text().catch(() => '');
      let detail = '';
      try {
        detail = JSON.parse(raw)?.detail ?? '';
      } catch {
        detail = raw;
      }
      throw new Error(detail || res.statusText || `HTTP ${res.status}`);
    }
    return await res.json();
  }, []);

  return {
    tables, activeTable, schema, data,
    isLoadingTables, isLoadingData, error,
    sortCol, sortOrder, offset, PAGE_SIZE, allSchemas, tableMetadata,
    selectTable, toggleSort, paginate, runQuery, refreshMetadata,
  };
}
