---
name: frontend-patterns
version: 1.0.0
type: pattern-skill
domains: [architecture, frontend]
dependencies: [frontend-review, ui-design]
load_level: on-demand
max_tokens: 800
triggers:
  keywords: ["frontend", "react", "component", "ui", "state management", "rendering", "virtual dom"]
  roles: [frontend-developer, fullstack-developer]
description: "Frontend design patterns and component architecture guidelines"
---

# Skill: frontend-patterns

> **Version**: 1.0.0
> **Description**: Frontend design patterns and component architecture guidelines
> **Domains**: architecture, frontend

---

## Component Architecture Patterns
<!-- PURPOSE: Guide Agent in designing maintainable, scalable frontend component hierarchies. Patterns should be technology-agnostic where possible, with React as primary reference implementation. -->

### Container/Presentational Pattern

**When to Use**: Application has complex state management or data fetching mixed with UI rendering.

**Structure**:
```
Container Component (Smart)
├── Data fetching
├── State management
├── Business logic
└── Renders Presentational Component(s)

Presentational Component (Dumb)
├── Pure rendering
├── Props-driven
└── No external dependencies
```

**Benefits**:
- Separation of concerns: testing UI without data mocks
- Reusability: same presentational component with different data sources
- Team scalability: designers own presentational, developers own containers

**Implementation** (React):
```javascript
// Container: UserProfileContainer.jsx
function UserProfileContainer({ userId }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    fetchUser(userId).then(data => {
      setUser(data);
      setLoading(false);
    });
  }, [userId]);
  
  return <UserProfile user={user} loading={loading} />;
}

// Presentational: UserProfile.jsx
function UserProfile({ user, loading }) {
  if (loading) return <Spinner />;
  return (
    <Card>
      <Avatar src={user.avatar} />
      <Name>{user.name}</Name>
      <Bio>{user.bio}</Bio>
    </Card>
  );
}
```

### Compound Components Pattern

**When to Use**: Complex UI with multiple related sub-components that share implicit state.

**Example**: Tabs, Accordions, Dropdowns

**Structure**:
```javascript
// Instead of prop-drilling configuration
<Tabs selectedTab={currentTab} onChange={setCurrentTab}>
  <Tabs.List>
    <Tabs.Tab id="first">First</Tabs.Tab>
    <Tabs.Tab id="second">Second</Tabs.Tab>
  </Tabs.List>
  <Tabs.Panel id="first">Content 1</Tabs.Panel>
  <Tabs.Panel id="second">Content 2</Tabs.Panel>
</Tabs>
```

**Implementation Strategy**:
1. Parent provides context with shared state
2. Children use context to coordinate
3. Consumers compose declaratively without prop drilling

### Higher-Order Components (HOC)

**When to Use**: Cross-cutting concerns (authentication, logging, data fetching) that apply to multiple components.

**Pattern**:
```javascript
const withAuth = (WrappedComponent) => {
  return function WithAuthComponent(props) {
    const { user } = useAuth();
    if (!user) return <Redirect to="/login" />;
    return <WrappedComponent {...props} user={user} />;
  };
};

// Usage
export default withAuth(Dashboard);
```

**⚠️ 2024 Guidance**:
- **Prefer**: Custom Hooks for most cases (better composition, clearer data flow)
- **Still Valid**: When you need to wrap component tree or add display name logic

---

## State Management Patterns

### Hierarchy of State Placement

**Decision Tree**:

```
Start: Does this state need to be shared?
├── No → useState in component
└── Yes → What's the scope?
    ├── Sibling components only → Lift to common parent
    ├── Multiple routes/pages → Context API / Zustand
    ├── Server-cached data → React Query / SWR
    └── Complex interactions → Redux / Zustand / Jotai
```

### State Shape Guidelines

**Normalization** (like a database):
```javascript
// ❌ Avoid nested state
{
  posts: [
    { id: 1, author: { id: 5, name: "John" }, comments: [...] }
  ]
}

// ✅ Normalize into entities
{
  posts: {
    byId: { 1: { id: 1, authorId: 5, commentIds: [10, 11] } },
    allIds: [1]
  },
  users: { byId: { 5: { id: 5, name: "John" } } },
  comments: { byId: { 10: {...}, 11: {...} } }
}
```

**Benefits**:
- Single source of truth for each entity
- Easy updates without deep merges
- Consistent data across components

### Derived State

**Rule**: Don't store what you can compute.

```javascript
// ❌ Redundant state
const [items, setItems] = useState([]);
const [itemCount, setItemCount] = useState(0); // Don't store this

useEffect(() => {
  setItemCount(items.length);
}, [items]);

// ✅ Compute on render
const itemCount = items.length;

// ✅ useMemo for expensive computations
const sortedItems = useMemo(() => 
  [...items].sort((a, b) => b.score - a.score),
  [items]
);
```

---

## Rendering Patterns

### Conditional Rendering Strategies

**Pattern 1: Early Return** (for loading/error states)
```javascript
function Dashboard() {
  const { data, loading, error } = useDashboardData();
  
  if (loading) return <SkeletonDashboard />;
  if (error) return <ErrorMessage error={error} />;
  if (!data) return <EmptyState />;
  
  return <DashboardContent data={data} />;
}
```

**Pattern 2: Ternary for Binary Choice**
```javascript
{isEditing ? <EditForm /> : <ViewMode />}
```

**Pattern 3: Logical && (Caution)**
```javascript
// ⚠️ Danger: count could be 0
{count && <Counter value={count} />}  // Renders "0" when count is 0

// ✅ Safe
{count > 0 && <Counter value={count} />}
{cards.length > 0 ? <CardList cards={cards} /> : <EmptyState />}
```

### List Rendering Optimization

```javascript
// ✅ Key should be stable identifier
{items.map(item => (
  <ListItem key={item.id} item={item} />
))}

// ✅ Memoize expensive item components
const MemoizedItem = memo(ListItem, (prev, next) => 
  prev.item.id === next.item.id && prev.item.updatedAt === next.item.updatedAt
);

// ✅ virtualization for large lists
import { FixedSizeList } from 'react-window';
// Render only visible items in 10k+ item lists
```

---

## Performance Patterns

### useMemo / useCallback Guidelines

**When to Use**:
```javascript
// ✅ Expensive computations
const sortedData = useMemo(() => 
  data.sort(complexCompare),
  [data]
);

// ✅ Referential stability for child props
const handleSubmit = useCallback((values) => {
  submitForm(values);
}, []); // Only re-create if deps change

// ✅ Breaking re-render chains
const contextValue = useMemo(() => ({ 
  user, 
  updateUser 
}), [user]);
```

**When NOT to Use**:
```javascript
// ❌ Overhead exceeds benefit
const name = useMemo(() => user.firstName + user.lastName, [user]);

// ❌ Premature optimization - measure first!
const handleClick = useCallback(() => setCount(c => c + 1), []);
// Simple event handlers rarely benefit
```

### Code Splitting Strategy

**Route-based** (automatic with React.lazy):
```javascript
const Dashboard = lazy(() => import('./Dashboard'));
const Settings = lazy(() => import('./Settings'));

function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Suspense>
  );
}
```

**Component-based** (for below-fold content):
```javascript
const HeavyChart = lazy(() => import('./HeavyChart'));

function Report() {
  const [showChart, setShowChart] = useState(false);
  return (
    <div>
      <Summary />
      <button onClick={() => setShowChart(true)}>Show Details</button>
      {showChart && (
        <Suspense fallback={<ChartSkeleton />}>
          <HeavyChart />
        </Suspense>
      )}
    </div>
  );
}
```

---

## Styling Patterns

### CSS Architecture

**Preferred Approaches** (in order):

1. **CSS-in-JS** (styled-components / emotion) - Component-scoped, dynamic theming
2. **CSS Modules** - Scoped class names, zero runtime cost
3. **Utility-first** (Tailwind) - Rapid development, built-in design system
4. **CSS Variables** - Theme switching, runtime customization

**Avoid**: Global CSS without scoping (naming collisions, specificity wars)

### Component Styling Structure

```css
/* Component: Button.module.css */
.btn { }
.btn-primary { }
.btn-secondary { }
.btn-large { }
.btn-small { }
.btn:disabled { }
.btn-loading { }

/* Avoid deep nesting - flat BEM-like structure */
```

---

## Integration Guide

### When This Skill Activates

| Context | Trigger | Application |
|---------|---------|-------------|
| Design | Component architecture decisions | Container/Presentational pattern selection |
| Implementation | Writing UI components | State placement, performance optimization |
| Quality | Component testing strategy | Testable component structure |

### Related Patterns

- **Visual Design**: Color, typography, spacing decisions
- **Code Quality**: Review checklists for frontend code
- **Testing**: Component and integration testing approaches
- **Performance**: Render optimization techniques

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-26 | Initial creation with React patterns for component architecture, state management, and rendering optimization |