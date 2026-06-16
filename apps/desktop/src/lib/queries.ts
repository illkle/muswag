import { db } from '#/lib/db-renderer';
import { useLiveQuery } from '@tanstack/react-db';

export const useUser = () => {
  return useLiveQuery((q) => q.from({ users: db.userCredentials }).findOne());
};

export const useSyncs = () => {
  return useLiveQuery((q) => q.from({ syncs: db.syncs }));
};
