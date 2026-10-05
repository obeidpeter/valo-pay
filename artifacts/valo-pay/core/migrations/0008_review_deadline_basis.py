from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0007_audit_actor_user_id_audit_after_state_and_more")]
    operations = [
        migrations.AddField(
            model_name="review", name="deadline_basis", field=models.JSONField(default=dict),
        ),
    ]