import { Placeholder } from '../../components/Placeholder';
import { displayName } from '../../api/types';
import { useAuth } from '../../auth/context';

export default function WorkScreen() {
  const { user } = useAuth();
  const subtitle = user ? `${displayName(user)} · ${user.role}` : undefined;

  return (
    <Placeholder
      title="My Work"
      subtitle={subtitle}
      message="Your assigned tasks will appear here, available offline."
    />
  );
}
