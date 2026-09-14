INSERT INTO companies (id, name, domain, industry) VALUES
  ('company-northline', 'Northline Studio', '', 'Design agency'),
  ('company-harbour', 'Harbour Property', '', 'Property services'),
  ('company-cedar', 'Cedar & Co', '', 'Consulting');
INSERT INTO contacts (id, first_name, last_name, email, company_id, title, status) VALUES
  ('contact-alex', 'Alex', 'Morgan', 'alex@northline.example', 'company-northline', 'Operations director', 'customer'),
  ('contact-jamie', 'Jamie', 'Chen', 'jamie@harbour.example', 'company-harbour', 'Managing director', 'lead'),
  ('contact-sam', 'Sam', 'Taylor', 'sam@cedar.example', 'company-cedar', 'Partner', 'lead');
INSERT INTO stages (key, label, color, position, is_won, is_lost) VALUES
  ('prospect', 'Prospect', 'sky', 0, 0, 0),
  ('qualified', 'Qualified', 'violet', 1, 0, 0),
  ('proposal', 'Proposal', 'amber', 2, 0, 0),
  ('negotiation', 'Negotiation', 'orange', 3, 0, 0),
  ('won', 'Won', 'emerald', 4, 1, 0),
  ('lost', 'Lost', 'rose', 5, 0, 1);
INSERT INTO deals (id, name, contact_id, value, stage, notes) VALUES
  ('deal-onboarding', 'Client onboarding portal', 'contact-alex', 4800, 'qualified', 'Bring project updates and approvals into one place.'),
  ('deal-property', 'Property operations workspace', 'contact-jamie', 7200, 'proposal', 'Connect buyer enquiries, properties, and documents.'),
  ('deal-reporting', 'Monthly client reporting', 'contact-sam', 2400, 'prospect', 'Replace the weekly spreadsheet round-up.'),
  ('deal-support', 'Client support rollout', 'contact-alex', 3600, 'won', 'The first team is ready to start.');
INSERT INTO activities (id, entity_type, entity_id, type, body) VALUES
  ('activity-alex', 'contact', 'contact-alex', 'note', 'Interested in giving clients one place for project updates.'),
  ('activity-jamie', 'contact', 'contact-jamie', 'note', 'Follow up with a walkthrough of the property workflow.');
