interface Pagination {
  page: number;
  pageSize: number;
  totalCount: number;
}

interface Resource {
  _id: string;
}

interface Collection<T> {
  data: T[];
}

interface PaginatedCollection<T> extends Collection<T>, Pagination {}

interface ViewEvent {
  schemaVersion: string;
  requestId: string;
  movieId: string;
  publishedAt: string;
}
