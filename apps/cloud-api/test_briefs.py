import copy
import json

import handler as api
import unittest
import test_handler as base


class BriefTests(unittest.TestCase):
    event = base.ApiTests.event
    call = base.ApiTests.call
    create = base.ApiTests.create
    def setUp(self):
        base.ApiTests.setUp(self)
        self.project = self.create()[1]
        self.pk = 'PROJECT#' + self.project['id']
        self.path = '/api/projects/' + self.project['id'] + '/briefs'
        self.sequence = 0

    def write(self, body, action='', who='owner', key=None):
        self.sequence += 1
        return self.call(self.event(who, self.path + action, body, key or 'brief-request-%s' % self.sequence))

    def draft(self, version=0, text='Build a five-page website.', key=None):
        return self.write({'expectedVersion': version, 'paragraphs': [{'id': 'p-scope', 'text': text}]}, key=key)

    def submit(self, brief):
        return self.write({k: brief[k] for k in ('version', 'hash')}, '/submit')

    def decide(self, brief, decision='approve', revision=0, key=None):
        return self.write({**{k: brief[k] for k in ('version', 'hash')}, 'decision': decision, 'expectedScopeRevision': revision}, '/decide', 'alex', key)

    def view(self, who='owner'):
        return self.call(self.event(who, self.path))

    def test_brief_lifecycle_baseline_and_exact_attributed_decision(self):
        self.assertIsNone(self.view()[1]['latest'])
        status, first = self.draft()
        self.assertEqual(status, 201)
        self.assertEqual(first['status'], 'draft')
        self.assertIsNone(self.view('alex')[1]['latest'])
        self.assertEqual(self.submit(first)[0], 200)
        self.assertTrue(self.view('alex')[1]['canDecide'])
        status, approved = self.decide(first)
        self.assertEqual(status, 200)
        self.assertEqual(approved['approval']['actorId'], 'alex')
        self.assertEqual(approved['approval']['hash'], first['hash'])
        self.assertEqual(self.view()[1]['project']['scopeRevision'], 1)
        self.assertEqual(self.view()[1]['project']['contextRevision'], 2)
        second = self.draft(1, 'Replacement scope.')[1]
        self.assertEqual(self.view()[1]['baseline'], approved)
        self.assertEqual(self.view('alex')[1]['latest'], approved)
        self.submit(second)
        self.assertEqual(self.decide(second, revision=1)[0], 200)
        self.assertEqual(self.view()[1]['baseline']['version'], 2)
        self.assertEqual(self.store.get(self.pk, api.brief_key(1)), approved)

    def test_drafts_and_history_are_private_and_cursors_actor_bound(self):
        first = self.draft()[1]
        self.submit(first)
        self.draft(1, 'Private next version')
        self.store.page_size = 1
        event = self.event('alex', self.path + '/history')
        page = self.call(event)[1]
        self.assertEqual([b['version'] for b in page['items']], [1])
        event['queryStringParameters'] = {'cursor': page['nextCursor']}
        self.assertEqual(self.call(event)[1]['items'], [])
        event['requestContext']['authorizer']['jwt']['claims']['sub'] = 'owner'
        self.assertEqual(self.call(event)[0], 400)
        self.assertFalse(self.view('alex')[1]['canDecide'])
        self.assertNotIn('Private', json.dumps(self.view('alex')))
        self.assertNotIn('briefVersion', self.view('alex')[1]['project'])

    def test_other_clients_workspaces_and_roles_cannot_read_or_write(self):
        brief = self.draft()[1]
        for who in ('jules', 'outsider', 'foreign'):
            for suffix in ('', '/history'):
                self.assertEqual(self.call(self.event(who, self.path + suffix))[0], 404)
            self.assertEqual(self.write({'version': 1, 'hash': brief['hash']}, '/submit', who)[0], 404)
        self.assertEqual(self.write({'expectedVersion': 1, 'paragraphs': brief['paragraphs']}, who='alex')[0], 403)
        self.submit(brief)
        body = {'version': 1, 'hash': brief['hash'], 'decision': 'approve', 'expectedScopeRevision': 0}
        self.assertEqual(self.write(body, '/decide', 'owner')[0], 403)

    def test_latest_version_hash_and_scope_required(self):
        first = self.draft()[1]
        self.assertEqual(self.decide(first)[0], 404)
        self.assertEqual(self.write({'version': 1, 'hash': '0' * 64}, '/submit')[0], 409)
        self.submit(first)
        self.assertEqual(self.decide({**first, 'hash': '0' * 64})[0], 409)
        self.assertEqual(self.decide(first, revision=1)[0], 409)
        second = self.draft(1)[1]
        self.assertEqual(self.decide(first)[0], 409)
        self.assertEqual(self.submit(first)[0], 409)
        self.assertEqual(self.draft(1)[0], 409)
        self.submit(second)
        self.assertEqual(self.decide(second)[0], 200)
        self.assertEqual(self.decide(second)[0], 409)
        self.assertEqual(self.submit(second)[0], 409)

    def test_rejection_keeps_previous_baseline(self):
        first = self.draft()[1]
        self.submit(first)
        self.decide(first)
        second = self.draft(1, 'A larger scope')[1]
        self.submit(second)
        self.assertEqual(self.decide(second, 'reject', 1)[1]['status'], 'rejected')
        view = self.view()[1]
        self.assertEqual(view['baseline']['version'], 1)
        self.assertEqual(view['project']['scopeRevision'], 1)
        self.assertEqual(view['project']['contextRevision'], 4)

    def test_replay_survives_later_changes_without_duplicate_records(self):
        first = self.draft(key='draft-key-123')[1]
        self.submit(first)
        approved = self.decide(first, key='decision-key-123')[1]
        commits = self.store.commits
        self.assertEqual(self.decide(first, key='decision-key-123'), (200, approved))
        self.assertEqual(self.draft(key='draft-key-123'), (200, first))
        self.assertEqual(self.store.commits, commits)
        self.assertEqual(self.decide(first, 'reject', key='decision-key-123')[0], 409)
        self.assertEqual(len(self.store.query(self.pk, 'APPROVAL#')[0]), 1)
        self.assertEqual(len(self.store.query(self.pk, 'AUDIT#')[0]), 4)
        self.store.rows[('IDENTITY#alex', 'PROFILE')]['active'] = False
        self.assertEqual(self.draft(key='draft-key-123')[0], 403)

    def test_concurrent_decisions_commit_only_one(self):
        brief = self.draft()[1]
        self.submit(brief)
        def compete():
            self.store.before_commit = lambda: None
            self.assertEqual(self.decide(brief, 'reject')[0], 200)
        self.store.before_commit = compete
        self.assertEqual(self.decide(brief)[0], 409)
        self.assertEqual(self.view()[1]['latest']['status'], 'rejected')
        self.assertEqual(self.view()[1]['project']['scopeRevision'], 0)
        self.assertEqual(len(self.store.query(self.pk, 'APPROVAL#')[0]), 1)

    def test_concurrent_duplicate_decision_returns_original(self):
        brief = self.draft()[1]
        self.submit(brief)
        def compete():
            self.store.before_commit = lambda: None
            self.assertEqual(self.decide(brief, key='same-decision-123')[0], 200)
        self.store.before_commit = compete
        self.assertEqual(self.decide(brief, key='same-decision-123')[0], 200)
        self.assertEqual(self.view()[1]['project']['scopeRevision'], 1)
        self.assertEqual(len(self.store.query(self.pk, 'APPROVAL#')[0]), 1)

    def test_concurrent_draft_blocks_old_approval(self):
        brief = self.draft()[1]
        self.submit(brief)
        def compete():
            self.store.before_commit = lambda: None
            self.assertEqual(self.draft(1)[0], 201)
        self.store.before_commit = compete
        self.assertEqual(self.decide(brief)[0], 409)
        self.assertIsNone(self.view()[1]['baseline'])

    def test_concurrent_revocation_and_reassignment_leave_no_partial_records(self):
        brief = self.draft()[1]
        self.submit(brief)
        before = copy.deepcopy(self.store.rows)
        self.store.before_commit = lambda: self.store.rows[('IDENTITY#alex', 'PROFILE')].update(active=False)
        self.assertEqual(self.decide(brief)[0], 403)
        self.store.rows[('IDENTITY#alex', 'PROFILE')]['active'] = True
        self.assertEqual(before, self.store.rows)
        self.store.before_commit = lambda: self.store.rows[(self.pk, 'METADATA')].update(clientId='jules')
        self.assertEqual(self.decide(brief)[0], 404)
        self.assertEqual(self.store.get(self.pk, api.brief_key(1))['status'], 'submitted')
        self.assertEqual(self.store.query(self.pk, 'APPROVAL#')[0], [])

    def test_write_validation_and_boundaries(self):
        body = {'expectedVersion': 0, 'paragraphs': [{'id': 'p-one', 'text': 'Scope'}]}
        invalid = [[], {**body, 'expectedVersion': True}, {**body, 'expectedVersion': -1}, {**body, 'ownerId': 'forged'}, {**body, 'paragraphs': []}, {**body, 'paragraphs': body['paragraphs'] * 2}, {**body, 'paragraphs': [{'id': 'bad', 'text': 'Scope'}]}, {**body, 'paragraphs': [{'id': 'p-one', 'text': ' '}]}, {**body, 'paragraphs': [{'id': 'p-one', 'text': 'x' * 4001}]}]
        for value in invalid:
            self.assertEqual(self.write(value)[0], 400)
        for header, value, status in [('origin', 'https://foreign.invalid', 403), ('content-type', 'text/plain', 415), ('idempotency-key', 'short', 400)]:
            event = self.event(path=self.path, body=body)
            event['headers'][header] = value
            self.assertEqual(self.call(event)[0], status)
        large = {'expectedVersion': 0, 'paragraphs': [{'id': 'p-%s' % i, 'text': 'अ' * 4000} for i in range(30)]}
        self.assertEqual(self.write(large)[0], 413)

    def test_dynamo_replacement_conditions_share_no_duplicate_item_actions(self):
        calls = []
        class Client:
            def transact_write_items(inner, **args):
                calls.append(args)
        store = api.DynamoStore(Client(), 'table')
        store.transact([('IDENTITY#a', 'PROFILE', {'active': True})], [('p', 'AUDIT#one', {})], [('p', 'METADATA', {'revision': 0}, {'revision': 1}), ('p', 'BRIEF_HEAD', None, {'version': 1})])
        actions = calls[0]['TransactItems']
        self.assertEqual(actions[2]['Put']['ConditionExpression'], '#data = :expected')
        self.assertEqual(actions[2]['Put']['ExpressionAttributeValues'][':expected']['S'], '{"revision":0}')
        self.assertEqual(actions[3]['Put']['ConditionExpression'], 'attribute_not_exists(pk)')
