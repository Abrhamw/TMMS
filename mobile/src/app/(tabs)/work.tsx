import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Link } from 'expo-router';
import { useAuth } from '../../auth/context';
import { StatusChip } from '../../components/StatusChip';
import { getDb } from '../../db';
import { listTasks, type CachedTask } from '../../db/queries';
import { pullTasks } from '../../sync/pull';
import { colors, radius, spacing } from '../../theme';

const FILTERS = ['ALL', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_VERIFICATION', 'COMPLETED'];

function TaskRow({ task }: { task: CachedTask }) {
  const meta = [
    task.line_name ?? task.crew_name,
    task.due_date ? `Due ${task.due_date.slice(0, 10)}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <Link href={`/task/${task.server_id}`} asChild>
      <Pressable style={styles.row}>
        <View style={styles.rowTop}>
          <Text style={styles.taskNumber}>{task.task_number ?? `#${task.server_id}`}</Text>
          <StatusChip status={task.status} />
        </View>
        <Text style={styles.title} numberOfLines={2}>
          {task.title ?? 'Untitled task'}
        </Text>
        {meta ? <Text style={styles.meta}>{meta}</Text> : null}
      </Pressable>
    </Link>
  );
}

export default function WorkScreen() {
  const { client } = useAuth();
  const [tasks, setTasks] = useState<CachedTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const loadLocal = useCallback(async () => {
    const db = await getDb();
    setTasks(await listTasks(db));
  }, []);

  const sync = useCallback(async () => {
    const db = await getDb();
    try {
      await pullTasks(db, client);
      setOffline(false);
    } catch {
      setOffline(true);
    }
    await loadLocal();
  }, [client, loadLocal]);

  useEffect(() => {
    let active = true;
    void (async () => {
      await loadLocal();
      if (active) setLoading(false);
      await sync();
    })();
    return () => {
      active = false;
    };
  }, [loadLocal, sync]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await sync();
    setRefreshing(false);
  }, [sync]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return tasks.filter((task) => {
      if (statusFilter !== 'ALL' && task.status !== statusFilter) return false;
      if (!term) return true;
      const haystack = `${task.task_number ?? ''} ${task.title ?? ''}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [tasks, search, statusFilter]);

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <TextInput
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder="Search tasks"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.filters}>
          {FILTERS.map((f) => {
            const active = f === statusFilter;
            return (
              <Pressable
                key={f}
                onPress={() => setStatusFilter(f)}
                style={[styles.filter, active && styles.filterActive]}
              >
                <Text style={[styles.filterText, active && styles.filterTextActive]}>
                  {f === 'ALL' ? 'All' : f.replace(/_/g, ' ')}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {offline ? <Text style={styles.offline}>Offline — showing saved work</Text> : null}
      </View>

      {loading ? (
        <ActivityIndicator style={styles.loading} color={colors.primary} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => String(item.server_id)}
          renderItem={({ item }) => <TaskRow task={item} />}
          contentContainerStyle={visible.length === 0 ? styles.emptyWrap : styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <Text style={styles.empty}>No assigned tasks yet. Pull down to sync.</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  toolbar: { padding: spacing.md, gap: spacing.sm },
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
    color: colors.text,
  },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  filter: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    backgroundColor: colors.card,
  },
  filterActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterText: { fontSize: 12, color: colors.muted },
  filterTextActive: { color: '#fff', fontWeight: '600' },
  offline: { fontSize: 12, color: colors.warning },
  loading: { marginTop: spacing.xl },
  listContent: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl },
  emptyWrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: colors.muted, fontSize: 14 },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  taskNumber: { fontSize: 12, color: colors.muted, fontWeight: '600' },
  title: { fontSize: 15, color: colors.text, marginTop: spacing.xs, fontWeight: '600' },
  meta: { fontSize: 12, color: colors.muted, marginTop: spacing.xs },
});
