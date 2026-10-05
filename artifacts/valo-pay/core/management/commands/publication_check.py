"""Fail closed on unsafe configuration/missing schema; never migrate or seed."""
from django.apps import apps
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction


class Command(BaseCommand):
    help = "Read-only guarded-publication configuration and optional schema check."

    def add_arguments(self, parser):
        parser.add_argument("--database", action="store_true")

    def handle(self, *args, **options):
        if settings.DEBUG or "*" in settings.ALLOWED_HOSTS:
            raise CommandError("Debug or wildcard-host publication is prohibited.")
        if not (settings.SESSION_COOKIE_SECURE and settings.CSRF_COOKIE_SECURE):
            raise CommandError("Secure cookies are required.")
        if getattr(settings, "ACCESS_TEST_DELIVERY", False) or getattr(settings, "SYNTHETIC_LEAD_TEST", False):
            raise CommandError("Test delivery and lead acceptance must stay disabled.")
        if settings.CSRF_TRUSTED_ORIGINS:
            raise CommandError("This release only permits same-origin CSRF.")
        if options["database"]:
            if connection.vendor != "postgresql":
                raise CommandError("Publication requires PostgreSQL.")
            missing = []
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION READ ONLY")
                tables = set(connection.introspection.table_names(cursor))
                for model in apps.get_models(include_auto_created=True):
                    table = model._meta.db_table
                    if not model._meta.managed:
                        continue
                    if table not in tables:
                        missing.append(table)
                        continue
                    columns = {field.name for field in connection.introspection.get_table_description(cursor, table)}
                    missing.extend(f"{table}.{field.column}" for field in model._meta.local_fields if field.column not in columns)
                    constraints = connection.introspection.get_constraints(cursor, table)
                    missing.extend(f"{table}.{constraint.name}" for constraint in model._meta.constraints if constraint.name not in constraints)
            if missing:
                raise CommandError("Publish-managed schema is incomplete: " + ", ".join(sorted(missing)))
            self.stdout.write("Read-only schema check passed: expected runtime tables, columns and named model constraints exist.")
        self.stdout.write("Guarded-publication configuration passed. No migrations, seeds or deliveries executed.")