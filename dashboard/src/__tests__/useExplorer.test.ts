import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('@/lib/apiClient', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/apiClient';
import { useExplorer } from '@/hooks/useExplorer';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function errorResponse(detail: string, status = 500): Response {
  return {
    ok: false,
    status,
    json: async () => ({ detail }),
    text: async () => detail,
  } as Response;
}

describe('useExplorer', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it('starts in loading state, then populates tables + schemas on success', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/tables') {
        return jsonResponse({
          tables: [
            { TABLE_NAME: 'users', TABLE_ROWS: 10 },
            { TABLE_NAME: 'orders', TABLE_ROWS: 5 },
          ],
        });
      }
      if (path === '/api/metadata/all') {
        return jsonResponse({
          metadata: {
            users: { columns: [{ name: 'id', type: 'int', key: 'PRI', nullable: 'NO' }], indexes: [] },
            orders: { columns: [{ name: 'id', type: 'int', key: 'PRI', nullable: 'NO' }], indexes: [] },
          },
        });
      }
      return errorResponse('unexpected ' + path);
    });

    const { result } = renderHook(() => useExplorer());

    expect(result.current.isLoadingTables).toBe(true);
    expect(result.current.tables).toEqual([]);

    await waitFor(() => expect(result.current.isLoadingTables).toBe(false));

    expect(result.current.tables).toHaveLength(2);
    expect(result.current.allSchemas).toEqual({ users: ['id'], orders: ['id'] });
    expect(result.current.error).toBeNull();
  });

  it('sets error on failed /api/tables', async () => {
    mockApiFetch.mockResolvedValueOnce(errorResponse('boom', 503));
    mockApiFetch.mockResolvedValueOnce(jsonResponse({ metadata: {} }));

    const { result } = renderHook(() => useExplorer());

    await waitFor(() => expect(result.current.isLoadingTables).toBe(false));
    expect(result.current.error).toContain('boom');
    expect(result.current.tables).toEqual([]);
  });

  it('handles empty tables + metadata without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/tables') return jsonResponse({ tables: [] });
      if (path === '/api/metadata/all') return jsonResponse({ metadata: {} });
      return errorResponse('unexpected');
    });

    const { result } = renderHook(() => useExplorer());

    await waitFor(() => expect(result.current.isLoadingTables).toBe(false));
    expect(result.current.tables).toEqual([]);
    expect(result.current.allSchemas).toEqual({});
    expect(result.current.tableMetadata).toEqual({});
    expect(result.current.error).toBeNull();
  });

  it('runQuery resolves with parsed JSON on 200', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/tables') return jsonResponse({ tables: [] });
      if (path === '/api/metadata/all') return jsonResponse({ metadata: {} });
      if (path === '/api/query') {
        return jsonResponse({
          columns: ['n'], rows: [{ n: 1 }], row_count: 1, elapsed_seconds: 0.01,
        });
      }
      return errorResponse('unexpected');
    });

    const { result } = renderHook(() => useExplorer());
    await waitFor(() => expect(result.current.isLoadingTables).toBe(false));

    const res = await result.current.runQuery('SELECT 1');
    expect(res.row_count).toBe(1);
    expect(res.rows).toEqual([{ n: 1 }]);
  });

  it('runQuery throws with backend detail on non-OK response', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/tables') return jsonResponse({ tables: [] });
      if (path === '/api/metadata/all') return jsonResponse({ metadata: {} });
      if (path === '/api/query') return errorResponse('Only read-only queries allowed', 403);
      return errorResponse('unexpected');
    });

    const { result } = renderHook(() => useExplorer());
    await waitFor(() => expect(result.current.isLoadingTables).toBe(false));

    await expect(result.current.runQuery('DROP TABLE x')).rejects.toThrow(
      /Only read-only queries allowed/
    );
  });

  it('refreshMetadata can be called manually and silently', async () => {
    let callCount = 0;
    mockApiFetch.mockImplementation(async (path: string) => {
      callCount++;
      if (path === '/api/tables') return jsonResponse({ tables: [{ TABLE_NAME: 't', TABLE_ROWS: 0 }] });
      if (path === '/api/metadata/all') return jsonResponse({ metadata: { t: { columns: [], indexes: [] } } });
      return errorResponse('unexpected');
    });

    const { result } = renderHook(() => useExplorer());
    await waitFor(() => expect(result.current.isLoadingTables).toBe(false));
    expect(callCount).toBeGreaterThanOrEqual(2);

    const before = callCount;
    await act(async () => { await result.current.refreshMetadata(true); });
    expect(callCount).toBe(before + 2);
    expect(result.current.tables).toHaveLength(1);
  });
});
