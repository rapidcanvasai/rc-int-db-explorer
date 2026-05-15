import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Database, Search, ChevronUp, ChevronDown, Loader2,
  ChevronLeft, ChevronRight, Columns3, RefreshCw, Sun, Moon,
  History as HistoryIcon, Trash2,
} from 'lucide-react';
import { useExplorer } from '@/hooks/useExplorer';
import { useDarkMode } from '@/hooks/useDarkMode';
import { useDragResize } from '@/hooks/useDragResize';
import { useQueryTabs } from '@/hooks/useQueryTabs';
import { apiFetch } from '@/lib/apiClient';
import QueryTabs from '@/components/QueryTabs';
import StatusBar from '@/components/StatusBar';
import TableTreeItem from '@/components/TableTreeItem';
import ConfirmDangerModal from '@/components/ConfirmDangerModal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import type { TableInfo } from '@/hooks/useExplorer';

function formatNum(n: number | null | undefined): string {
  return n != null ? Number(n).toLocaleString() : '?';
}

function groupKey(name: string): string {
  const i = name.indexOf('_');
  if (i <= 0) return 'general';
  return name.slice(0, i).toLowerCase();
}

interface Group { key: string; tables: TableInfo[] }

function groupTables(tables: TableInfo[]): Group[] {
  const buckets = new Map<string, TableInfo[]>();
  for (const t of tables) {
    const k = groupKey(t.TABLE_NAME);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(t);
  }
  // Tables alone in a bucket fall into 'other'.
  const groups: Group[] = [];
  const otherTables: TableInfo[] = [];
  const sortedKeys = Array.from(buckets.keys()).sort();
  for (const k of sortedKeys) {
    const arr = buckets.get(k)!;
    if (arr.length < 2 && k !== 'general') {
      otherTables.push(...arr);
    } else {
      groups.push({ key: k, tables: arr });
    }
  }
  if (otherTables.length) groups.push({ key: 'other', tables: otherTables });
  return groups;
}

const COLLAPSE_KEY = 'db-explorer:group-collapsed';

function loadCollapsed(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); }
  catch { return {}; }
}

export default function ExplorerPage() {
  const {
    tables, activeTable, schema, data,
    isLoadingTables, isLoadingData, error,
    sortCol, sortOrder, offset, PAGE_SIZE, allSchemas, tableMetadata,
    selectTable, toggleSort, paginate, runQuery, refreshMetadata, dropTable,
  } = useExplorer();

  const [dark, toggleDark] = useDarkMode();

  const [dbInfo, setDbInfo] = useState<
    { host: string; database: string; env?: string; destructive_ops_enabled?: boolean } | null
  >(null);
  useEffect(() => {
    apiFetch('/api/info').then(r => r.ok ? r.json() : null).then(setDbInfo).catch(() => {});
  }, []);
  const destructiveEnabled = !!dbInfo?.destructive_ops_enabled;

  // Confirmation modal state. Two flavors:
  //   - dropTable: triggered by trash icon on a sidebar row.
  //   - query: triggered when the SQL editor submits a DELETE/DROP/TRUNCATE.
  type Pending =
    | { kind: 'dropTable'; table: string }
    | { kind: 'query'; sql: string; firstWord: string };
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const closeConfirm = useCallback(() => {
    if (confirmBusy) return;
    setPending(null);
    setConfirmError(null);
  }, [confirmBusy]);

  const env = (dbInfo?.env ?? '').toUpperCase();
  const envBadgeClass = env === 'PROD'
    ? 'bg-red-600 text-white border-red-700'
    : env === 'DEV'
      ? 'bg-amber-500 text-amber-950 border-amber-600'
      : env === 'LOCAL'
        ? 'bg-emerald-600 text-white border-emerald-700'
        : 'bg-muted text-muted-foreground border-border';

  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [sidebarTab, setSidebarTab] = useState<'tables' | 'history'>('tables');

  const editor = useDragResize({
    axis: 'y', initial: 220, min: 80, max: 600,
    storageKey: 'db-explorer:query-panel-height', invert: true,
  });
  const sidebar = useDragResize({
    axis: 'x', initial: 320, min: 220, max: 600,
    storageKey: 'db-explorer:sidebar-width',
  });

  const tabsCtl = useQueryTabs();

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
  }, [collapsed]);

  const filteredTables = useMemo(() => {
    const q = filter.toLowerCase();
    return q ? tables.filter(t => t.TABLE_NAME.toLowerCase().includes(q)) : tables;
  }, [tables, filter]);

  const groups = useMemo(() => groupTables(filteredTables), [filteredTables]);

  const executeQuery = useCallback(async (sqlText: string) => {
    const tab = tabsCtl.activeTab;
    if (!tab) return;
    tabsCtl.updateTab(tab.id, { isRunning: true, error: null });
    try {
      const res = await runQuery(sqlText);
      tabsCtl.updateTab(tab.id, {
        isRunning: false, result: res, error: null, lastRunAt: Date.now(),
      });
      tabsCtl.recordHistory(sqlText, res);
      // If we just dropped/deleted, refresh the sidebar so counts catch up.
      if (res.kind === 'destructive') refreshMetadata(true);
    } catch (e) {
      tabsCtl.updateTab(tab.id, {
        isRunning: false, result: null,
        error: e instanceof Error ? e.message : 'Query failed',
      });
    }
  }, [runQuery, tabsCtl, refreshMetadata]);

  const handleRun = useCallback(async () => {
    const tab = tabsCtl.activeTab;
    if (!tab) return;
    const sqlText = tab.sql.trim();
    if (!sqlText) return;
    // Destructive prefixes get intercepted by the confirmation modal. Anything
    // else (SELECT/SHOW/etc.) goes straight through.
    const firstWord = sqlText.replace(/^\s+/, '').split(/\s+/)[0]?.toLowerCase() ?? '';
    if (['delete', 'drop', 'truncate'].includes(firstWord)) {
      setConfirmError(null);
      setPending({ kind: 'query', sql: sqlText, firstWord });
      return;
    }
    await executeQuery(sqlText);
  }, [executeQuery, tabsCtl]);

  const confirmPending = useCallback(async () => {
    if (!pending) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (pending.kind === 'dropTable') {
        await dropTable(pending.table);
      } else {
        await executeQuery(pending.sql);
      }
      setPending(null);
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setConfirmBusy(false);
    }
  }, [pending, dropTable, executeQuery]);

  const totalRows = data?.total ?? 0;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  const activeTab = tabsCtl.activeTab;
  const queryResult = activeTab?.result ?? null;
  // Treat empty string as no-error — otherwise the `queryResult || queryError`
  // check below silently falls through to the table-browser pane.
  const queryError = activeTab?.error || null;

  const lastQueryStatus = queryResult
    ? { rowCount: queryResult.row_count, elapsedSeconds: queryResult.elapsed_seconds, ts: activeTab?.lastRunAt ?? Date.now() }
    : null;

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Header */}
      <header className="border-b bg-background px-4 py-2 flex items-center gap-3 shrink-0">
        <Database className="h-5 w-5 text-primary" />
        <h1 className="text-sm font-semibold">DB Explorer</h1>
        {env && (
          <span
            className={`text-[10px] font-bold tracking-widest px-2 py-0.5 rounded border ${envBadgeClass}`}
            title={dbInfo ? `${dbInfo.database} @ ${dbInfo.host}` : env}
          >
            {env}
          </span>
        )}
        {dbInfo && (
          <span className="text-[11px] font-mono text-muted-foreground hidden md:inline">
            {dbInfo.database}
          </span>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleDark}
          className="h-7 w-7 p-0"
          aria-label="Toggle theme"
          title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </Button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside
          className="border-r bg-background flex flex-col shrink-0 relative"
          style={{ width: sidebar.size }}
        >
          <Tabs value={sidebarTab} onValueChange={v => setSidebarTab(v as 'tables' | 'history')} className="flex-1 flex flex-col min-h-0">
            <div className="px-2 pt-2 pb-1 border-b flex items-center gap-2">
              <TabsList className="h-7 p-0.5">
                <TabsTrigger value="tables" className="text-xs px-2 py-0.5 h-6">Tables</TabsTrigger>
                <TabsTrigger value="history" className="text-xs px-2 py-0.5 h-6 gap-1">
                  <HistoryIcon className="h-3 w-3" />
                  History
                </TabsTrigger>
              </TabsList>
              <div className="flex-1" />
              <Button
                variant="ghost" size="sm"
                onClick={() => refreshMetadata()}
                className="h-6 w-6 p-0"
                title="Refresh metadata"
                disabled={isLoadingTables}
              >
                <RefreshCw className={`h-3 w-3 ${isLoadingTables ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            <TabsContent value="tables" className="m-0 flex-1 flex flex-col min-h-0 data-[state=inactive]:hidden">
              <div className="p-2 border-b">
                <div className="relative">
                  <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Filter tables..."
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    className="pl-8 h-7 text-xs"
                  />
                </div>
              </div>

              <ScrollArea className="flex-1">
                {isLoadingTables ? (
                  <div className="p-4 text-center text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin mx-auto mb-1" />
                    Loading...
                  </div>
                ) : (
                  <div className="py-1">
                    {groups.map(g => {
                      const isCollapsed = collapsed[g.key];
                      return (
                        <div key={g.key}>
                          <button
                            onClick={() => setCollapsed(c => ({ ...c, [g.key]: !c[g.key] }))}
                            className="w-full flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent/50 sticky top-0 bg-background/95 backdrop-blur z-10 border-b border-border/50"
                          >
                            {isCollapsed
                              ? <ChevronRight className="h-3 w-3" />
                              : <ChevronDown className="h-3 w-3" />}
                            <span className="font-semibold">{g.key}</span>
                            <span className="opacity-60">({g.tables.length})</span>
                          </button>
                          {!isCollapsed && g.tables.map(t => (
                            <TableTreeItem
                              key={t.TABLE_NAME}
                              table={t}
                              meta={tableMetadata[t.TABLE_NAME]}
                              isActive={activeTable === t.TABLE_NAME}
                              onSelect={selectTable}
                              canDrop={destructiveEnabled}
                              onRequestDrop={name => {
                                setConfirmError(null);
                                setPending({ kind: 'dropTable', table: name });
                              }}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>

              <div className="px-3 py-1.5 border-t text-[11px] text-muted-foreground font-mono">
                {filteredTables.length} / {tables.length} tables
              </div>
            </TabsContent>

            <TabsContent value="history" className="m-0 flex-1 flex flex-col min-h-0 data-[state=inactive]:hidden">
              <div className="px-2 py-1.5 border-b flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground font-mono">
                  {tabsCtl.history.length} queries
                </span>
                <div className="flex-1" />
                {tabsCtl.history.length > 0 && (
                  <Button
                    variant="ghost" size="sm"
                    onClick={tabsCtl.clearHistory}
                    className="h-6 w-6 p-0"
                    title="Clear history"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
              <ScrollArea className="flex-1">
                {tabsCtl.history.length === 0 ? (
                  <div className="p-4 text-center text-xs text-muted-foreground">
                    No queries yet.
                  </div>
                ) : (
                  <div className="py-1">
                    {tabsCtl.history.map(h => (
                      <button
                        key={h.id}
                        onClick={() => tabsCtl.loadIntoActiveTab(h.sql)}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent border-b border-border/40"
                        title={h.sql}
                      >
                        <div className="font-mono truncate text-foreground">
                          {h.sql.replace(/\s+/g, ' ').slice(0, 80)}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 flex gap-2">
                          <span>{new Date(h.ts).toLocaleTimeString()}</span>
                          <span>·</span>
                          <span>{formatNum(h.rowCount)} rows</span>
                          <span>·</span>
                          <span>{h.elapsedSeconds.toFixed(3)}s</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>
          </Tabs>

          {/* Sidebar drag handle (right edge) */}
          <div
            onMouseDown={sidebar.onMouseDown}
            className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/40 transition-colors"
            aria-hidden
          />
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Data area */}
          <div className="flex-1 overflow-auto bg-background">
            {queryResult || queryError ? (
              <div className="p-4">
                {queryError && (
                  <div className="text-xs text-destructive mb-2 font-mono">{queryError}</div>
                )}
                {queryResult && (
                  <>
                    <div className="flex items-center gap-3 mb-3">
                      <h2 className="text-sm font-semibold">
                        {activeTab?.name ?? 'Query'} · Results
                      </h2>
                      {queryResult.kind === 'destructive' ? (
                        <Badge variant="outline" className="text-xs text-destructive border-destructive/40">
                          {formatNum(queryResult.affected_rows ?? 0)} rows affected
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">
                          {formatNum(queryResult.row_count)} rows
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-xs">
                        {queryResult.elapsed_seconds.toFixed(3)}s
                      </Badge>
                      {queryResult.limit_applied && (
                        <Badge
                          variant="outline"
                          className="text-xs text-amber-600 border-amber-600/40"
                          title={`Add an explicit LIMIT clause to override the ${queryResult.default_limit}-row cap.`}
                        >
                          auto LIMIT {queryResult.default_limit}
                        </Badge>
                      )}
                    </div>
                    {queryResult.columns.length > 0 && (
                      <div className="border rounded-md overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-muted/50">
                              {queryResult.columns.map(col => (
                                <TableHead key={col} className="text-xs h-8 whitespace-nowrap">{col}</TableHead>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {queryResult.rows.map((row, i) => (
                              <TableRow key={i}>
                                {queryResult.columns.map(col => (
                                  <TableCell key={col} className="text-xs py-1 max-w-[300px] truncate font-mono">
                                    {(row as Record<string, unknown>)[col] === null
                                      ? <span className="text-muted-foreground/40">NULL</span>
                                      : String((row as Record<string, unknown>)[col])}
                                  </TableCell>
                                ))}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : !activeTable ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <Database className="h-10 w-10 mb-3 opacity-20" />
                <p className="text-sm">Select a table from the sidebar</p>
              </div>
            ) : isLoadingData ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="p-4">
                <div className="flex items-center gap-3 mb-3">
                  <h2 className="text-sm font-semibold">{activeTable}</h2>
                  <Badge variant="outline" className="text-xs">
                    {formatNum(schema?.row_count)} rows
                  </Badge>
                  {schema && (
                    <Badge variant="outline" className="text-xs">
                      <Columns3 className="h-3 w-3 mr-1" />
                      {schema.columns.length} cols
                    </Badge>
                  )}
                </div>

                {schema && (
                  <details className="mb-4">
                    <summary className="text-xs text-primary cursor-pointer hover:underline">
                      Show schema ({schema.columns.length} columns)
                    </summary>
                    <div className="mt-2 border rounded-md overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/50">
                            <TableHead className="text-xs h-8">Column</TableHead>
                            <TableHead className="text-xs h-8">Type</TableHead>
                            <TableHead className="text-xs h-8">Nullable</TableHead>
                            <TableHead className="text-xs h-8">Key</TableHead>
                            <TableHead className="text-xs h-8">Default</TableHead>
                            <TableHead className="text-xs h-8">Extra</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {schema.columns.map(c => (
                            <TableRow key={c.COLUMN_NAME}>
                              <TableCell className="text-xs font-mono py-1">{c.COLUMN_NAME}</TableCell>
                              <TableCell className="text-xs text-muted-foreground py-1">{c.COLUMN_TYPE}</TableCell>
                              <TableCell className="text-xs py-1">{c.IS_NULLABLE}</TableCell>
                              <TableCell className="text-xs py-1">
                                {c.COLUMN_KEY && <Badge variant="secondary" className="text-[10px] px-1 py-0">{c.COLUMN_KEY}</Badge>}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground py-1">{c.COLUMN_DEFAULT ?? 'NULL'}</TableCell>
                              <TableCell className="text-xs text-muted-foreground py-1">{c.EXTRA}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </details>
                )}

                {data && (
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-xs text-muted-foreground">
                      {formatNum(totalRows)} rows total
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Page {currentPage} / {totalPages}
                    </span>
                    <Button variant="outline" size="sm" className="h-6 text-xs"
                      disabled={offset === 0} onClick={() => paginate(-1)}>
                      <ChevronLeft className="h-3 w-3" /> Prev
                    </Button>
                    <Button variant="outline" size="sm" className="h-6 text-xs"
                      disabled={offset + PAGE_SIZE >= totalRows} onClick={() => paginate(1)}>
                      Next <ChevronRight className="h-3 w-3" />
                    </Button>
                  </div>
                )}

                {data && data.columns.length > 0 && (
                  <div className="border rounded-md overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/50">
                          {data.columns.map(col => (
                            <TableHead key={col}
                              className="text-xs h-8 whitespace-nowrap cursor-pointer hover:bg-muted select-none"
                              onClick={() => toggleSort(col)}
                            >
                              {col}
                              {sortCol === col && (
                                sortOrder === 'asc'
                                  ? <ChevronUp className="h-3 w-3 inline ml-0.5" />
                                  : <ChevronDown className="h-3 w-3 inline ml-0.5" />
                              )}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.rows.map((row, i) => (
                          <TableRow key={i}>
                            {data.columns.map(col => (
                              <TableCell key={col} className="text-xs py-1 max-w-[300px] truncate font-mono">
                                {row[col] === null
                                  ? <span className="text-muted-foreground/40">NULL</span>
                                  : String(row[col])}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Editor split handle */}
          <div
            onMouseDown={editor.onMouseDown}
            className="h-[4px] cursor-row-resize hover:bg-primary/40 transition-colors select-none border-t"
          />

          <QueryTabs
            tabs={tabsCtl.tabs}
            activeTab={tabsCtl.activeTab}
            height={editor.size}
            schemas={allSchemas}
            dark={dark}
            onAddTab={() => tabsCtl.addTab()}
            onCloseTab={tabsCtl.closeTab}
            onSelectTab={tabsCtl.setActive}
            onRenameTab={tabsCtl.renameTab}
            onSqlChange={tabsCtl.setSql}
            onRun={handleRun}
          />
        </main>
      </div>

      <StatusBar
        dbInfo={dbInfo}
        tableCount={tables.length}
        activeTable={activeTable}
        activeTableRows={schema?.row_count}
        lastQuery={lastQueryStatus}
        errorText={error}
      />

      <ConfirmDangerModal
        open={!!pending}
        title={
          pending?.kind === 'dropTable'
            ? `Drop table "${pending.table}"?`
            : `Run ${pending?.firstWord.toUpperCase() ?? ''} query?`
        }
        description={
          pending?.kind === 'dropTable'
            ? `This will permanently drop the table "${pending.table}" from "${dbInfo?.database ?? 'the database'}" (${(dbInfo?.env ?? '').toUpperCase()}). All rows, indexes, and structure will be lost.`
            : `You are about to run a ${pending?.firstWord.toUpperCase() ?? ''} statement against "${dbInfo?.database ?? 'the database'}" (${(dbInfo?.env ?? '').toUpperCase()}). This will modify data and cannot be undone.`
        }
        sqlPreview={
          pending?.kind === 'dropTable'
            ? `DROP TABLE \`${pending.table}\`;`
            : pending?.sql
        }
        confirmPhrase={
          pending?.kind === 'dropTable' ? pending.table : 'DELETE'
        }
        confirmLabel={
          pending?.kind === 'dropTable' ? 'Drop table' : 'Run query'
        }
        isBusy={confirmBusy}
        errorText={confirmError}
        onConfirm={confirmPending}
        onCancel={closeConfirm}
      />
    </div>
  );
}
