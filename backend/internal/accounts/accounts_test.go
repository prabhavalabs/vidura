package accounts

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/prabhavalabs/vidura/backend/internal/config"
	"github.com/prabhavalabs/vidura/backend/internal/db"
)

type fixture struct {
	store *Store
	now   time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	database, err := db.OpenAndMigrate(filepath.Join(t.TempDir(), "vidura.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = database.Close() })

	cfg := &config.Config{SuperuserEmails: map[string]bool{"owner@example.com": true}}
	f := &fixture{store: NewStore(database, cfg), now: time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)}
	f.store.SetClock(func() time.Time { return f.now })
	return f
}

func identity(sub, email string) Identity {
	return Identity{Subject: sub, Email: email, EmailVerified: true, Name: "Name " + sub}
}

func (f *fixture) owner(t *testing.T) User {
	t.Helper()
	owner, err := f.store.SignIn(context.Background(), identity("owner-sub", "Owner@Example.com"))
	require.NoError(t, err)
	return owner
}

func (f *fixture) member(t *testing.T, sub, email string) User {
	t.Helper()
	ctx := context.Background()
	_, err := f.store.CreateInvite(ctx, f.owner(t), email)
	require.NoError(t, err)
	user, err := f.store.SignIn(ctx, identity(sub, email))
	require.NoError(t, err)
	return user
}

func TestOwnerSignsInAsSuperuserWithoutInvite(t *testing.T) {
	f := newFixture(t)
	owner := f.owner(t)

	assert.Equal(t, "owner@example.com", owner.Email)
	assert.Equal(t, RoleSuperuser, owner.Role)
	assert.True(t, owner.Owner)
	assert.True(t, owner.IsSuperuser())
}

func TestUninvitedAccountIsRefused(t *testing.T) {
	f := newFixture(t)
	_, err := f.store.SignIn(context.Background(), identity("x", "stranger@example.com"))
	assert.ErrorIs(t, err, ErrNotAllowed)
}

func TestUnverifiedEmailIsRefusedEvenForOwner(t *testing.T) {
	f := newFixture(t)
	id := identity("owner-sub", "owner@example.com")
	id.EmailVerified = false
	_, err := f.store.SignIn(context.Background(), id)
	assert.ErrorIs(t, err, ErrUnverifiedEmail)
}

func TestInvitedAccountBecomesMemberAndKeepsAccessAfterInviteRemoved(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	member := f.member(t, "m-sub", "Family@Example.com")
	assert.Equal(t, RoleMember, member.Role)
	assert.Equal(t, "family@example.com", member.Email)

	_, err := f.store.DeleteInvite(ctx, "family@example.com")
	require.NoError(t, err)

	again, err := f.store.SignIn(ctx, identity("m-sub", "family@example.com"))
	require.NoError(t, err)
	assert.Equal(t, member.ID, again.ID)
}

func TestSignInLinksImportedAccountByEmailOnce(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	member := f.member(t, "real-sub", "family@example.com")

	// A different Google account claiming the same email must not take over
	// the existing user.
	_, err := f.store.SignIn(ctx, identity("other-sub", "family@example.com"))
	assert.ErrorIs(t, err, ErrConflict)

	same, err := f.store.SignIn(ctx, identity("real-sub", "family@example.com"))
	require.NoError(t, err)
	assert.Equal(t, member.ID, same.ID)
}

func TestDisabledMemberCannotSignInOrUseSessions(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	owner := f.owner(t)
	member := f.member(t, "m-sub", "family@example.com")
	token, _, err := f.store.CreateSession(ctx, member.ID, SessionMeta{})
	require.NoError(t, err)

	disabled := StatusDisabled
	_, err = f.store.UpdateUser(ctx, owner, member.ID, UserUpdate{Status: &disabled})
	require.NoError(t, err)

	_, _, err = f.store.SessionUser(ctx, token)
	assert.ErrorIs(t, err, ErrNotFound, "disabling deletes the user's sessions")

	_, err = f.store.SignIn(ctx, identity("m-sub", "family@example.com"))
	assert.ErrorIs(t, err, ErrDisabled)
}

func TestSuperusersCannotChangeThemselvesOrOwners(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	owner := f.owner(t)
	member := f.member(t, "m-sub", "family@example.com")

	promote := RoleSuperuser
	promoted, err := f.store.UpdateUser(ctx, owner, member.ID, UserUpdate{Role: &promote})
	require.NoError(t, err)
	assert.Equal(t, RoleSuperuser, promoted.Role)

	demote := RoleMember
	_, err = f.store.UpdateUser(ctx, promoted, owner.ID, UserUpdate{Role: &demote})
	assert.ErrorIs(t, err, ErrForbidden, "an owner can't be demoted from the portal")

	_, err = f.store.UpdateUser(ctx, promoted, promoted.ID, UserUpdate{Role: &demote})
	assert.ErrorIs(t, err, ErrForbidden, "nobody can change their own account")

	_, err = f.store.DeleteUser(ctx, promoted, owner.ID)
	assert.ErrorIs(t, err, ErrForbidden)

	bogus := "god"
	_, err = f.store.UpdateUser(ctx, owner, member.ID, UserUpdate{Role: &bogus})
	assert.ErrorIs(t, err, ErrForbidden)
}

func TestDeleteUserRemovesInviteAndSessions(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	owner := f.owner(t)
	member := f.member(t, "m-sub", "family@example.com")
	token, _, err := f.store.CreateSession(ctx, member.ID, SessionMeta{})
	require.NoError(t, err)

	_, err = f.store.DeleteUser(ctx, owner, member.ID)
	require.NoError(t, err)

	_, _, err = f.store.SessionUser(ctx, token)
	assert.ErrorIs(t, err, ErrNotFound)
	_, err = f.store.SignIn(ctx, identity("m-sub", "family@example.com"))
	assert.ErrorIs(t, err, ErrNotAllowed)
}

func TestSessionsExpireAndSlide(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	owner := f.owner(t)
	token, expires, err := f.store.CreateSession(ctx, owner.ID, SessionMeta{UserAgent: "test"})
	require.NoError(t, err)
	assert.Equal(t, f.now.Add(SessionTTL), expires)

	_, renewed, err := f.store.SessionUser(ctx, token)
	require.NoError(t, err)
	assert.True(t, renewed.IsZero(), "no refresh within the first day")

	f.now = f.now.Add(2 * 24 * time.Hour)
	user, renewed, err := f.store.SessionUser(ctx, token)
	require.NoError(t, err)
	assert.Equal(t, owner.ID, user.ID)
	assert.Equal(t, f.now.Add(SessionTTL), renewed)
	require.NotNil(t, user.LastSeenAt)

	f.now = f.now.Add(SessionTTL + time.Minute)
	_, _, err = f.store.SessionUser(ctx, token)
	assert.ErrorIs(t, err, ErrNotFound)

	_, _, err = f.store.SessionUser(ctx, "not-a-token")
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestInvitesValidateAndReportAcceptance(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	owner := f.owner(t)

	for _, bad := range []string{"", "nope", "a@b@c", "Name <x@example.com>"} {
		_, err := f.store.CreateInvite(ctx, owner, bad)
		assert.ErrorIs(t, err, ErrInvalidEmail, bad)
	}

	email, err := f.store.CreateInvite(ctx, owner, " Pending@Example.com ")
	require.NoError(t, err)
	assert.Equal(t, "pending@example.com", email)
	_, err = f.store.CreateInvite(ctx, owner, "pending@example.com")
	assert.ErrorIs(t, err, ErrConflict)

	f.member(t, "m-sub", "joined@example.com")

	invites, err := f.store.ListInvites(ctx)
	require.NoError(t, err)
	require.Len(t, invites, 2)
	byEmail := map[string]Invite{}
	for _, invite := range invites {
		byEmail[invite.Email] = invite
	}
	assert.Nil(t, byEmail["pending@example.com"].AcceptedBy)
	assert.NotNil(t, byEmail["joined@example.com"].AcceptedBy)
	require.NotNil(t, byEmail["pending@example.com"].InvitedBy)
	assert.Equal(t, owner.ID, byEmail["pending@example.com"].InvitedBy.ID)

	counts, err := f.store.CountAccounts(ctx)
	require.NoError(t, err)
	assert.Equal(t, Counts{Users: 2, Active: 2, Superusers: 1, PendingInvites: 1}, counts)

	_, err = f.store.DeleteInvite(ctx, "missing@example.com")
	assert.ErrorIs(t, err, ErrNotFound)
}
